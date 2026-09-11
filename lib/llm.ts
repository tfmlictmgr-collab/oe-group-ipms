// One place that asks a language model a question, and keeps asking if the
// first one cannot answer.
//
// CLAUDE.md B3 specifies Claude as the primary and **Google Gemini** as the
// fallback with "auto-failover". Until now there was no failover at all: each
// call site had its own `try { ... } catch { return SAFE_DEFAULT }`, so an
// Anthropic outage did not break anything — it quietly turned every inbound
// message into an unclassified "needs human review" ticket for as long as the
// outage lasted.
//
// ⚠️ Gemini, not GPT, on purpose. B3 is a locked board decision, and
// substituting a vendor silently is exactly what A7.3 forbids. Nothing here is
// Gemini-specific beyond one adapter, so swapping later is a new `Provider`
// and one env var — but that would be a decision to take, not to assume.
//
// Deliberately built on `fetch` rather than a vendor SDK. It is one JSON
// endpoint, the payment gateways in this codebase already work this way, and
// it keeps a second AI SDK (and its transitive tree) out of a bundle that
// runs on every inbound webhook.

import Anthropic from "@anthropic-ai/sdk";

export type ProviderName = "anthropic" | "gemini" | "none";

export type LlmRequest = {
  system: string;
  user: string;
  maxTokens: number;
};

export type LlmResult =
  | { ok: true; text: string; provider: ProviderName }
  | { ok: false; provider: ProviderName; error: string };

export type Provider = {
  name: ProviderName;
  configured: () => boolean;
  complete: (req: LlmRequest) => Promise<LlmResult>;
};

// ── Anthropic (primary) ────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The model is the single largest lever on how well intake reads a message, and
// it was pinned to `claude-sonnet-4-6` — a generation behind — while the live
// WhatsApp transcript showed a question being filed as a work order. The prompts
// and the deterministic guards in `inbound-router.ts` do most of the work, but
// they are asking a model to make a judgement, and a better model makes it
// better.
//
// ── Which model, and why it is a chain rather than a name ──────────────────
//
// Measured, not asserted — 20 routing decisions taken from messages a tenant
// actually sent, five runs each (`scripts/measure-router-accuracy.mjs`):
//
//   claude-opus-5 (low)   98/100  98%   median 3.35s   $5/$25 per MTok
//   claude-sonnet-5      129/140  92%   median 2.33s   $2/$10 per MTok
//   claude-haiku-4-5       57/60  95%   median 1.49s   $1/$5  per MTok
//
// ⚠️ **All three scored a perfect run on the checks that must never move** — a
// real problem always opening a request. The safety line does not depend on the
// model, which is the point of the deterministic guards in `inbound-router.ts`:
// they, not the model, are what stops a leak being answered with "noted".
//
// What separates them is the continuation cases — is this more about the open
// request, or a new one? — and that is precisely the defect this whole change
// exists to fix (ticket 237A9C51: we asked a question and filed the answer as a
// new request). Sonnet 5 costs 2.5x less and answers 30% faster, and on any
// other axis would win; it loses six points exactly where this router is
// load-bearing. Its failures are all in the tolerable direction — a duplicate
// ticket, visible and closeable — so it is a legitimate choice, not a dangerous
// one. But paying 2.5x on a message that costs fractions of a naira, to be
// right more often on the one thing that prompted the work, is the trade worth
// making. **Opus 5 at low effort leads.**
//
// Sonnet 5 and Haiku 4.5 are both in the chain below and both measured safe. An
// operator who wants the cost or the latency back changes one environment
// variable — and should re-run the harness first, because "cheaper model" is
// not a change to make on trust.
//
// ⚠️ A hardcoded model id goes stale, and the failure is silent until the day it
// matters — the whole of the Gemini block below is that lesson, learned the
// expensive way. The same reasoning applies here, so the model is RESOLVED, not
// declared:
//   1. `ANTHROPIC_MODEL` if set — explicit configuration wins, and is tried alone.
//   2. The chain below, cheapest-capable first.
//   3. Discovery via the Models API, each candidate actually CALLED — because a
//      model that is listed is not the same as a model that answers.
// The winner is cached for the process, so a retired name is probed once rather
// than on every webhook.
const ANTHROPIC_CANDIDATES = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];

// Low effort on purpose. These calls emit one small JSON object from a short
// message — the work is judgement, not reasoning depth, and a classifier that
// deliberates is a webhook that times out.
const ANTHROPIC_EFFORT =
  (process.env.ANTHROPIC_EFFORT?.trim() as "low" | "medium" | "high" | undefined) || "low";

/** Cached across calls: the model that last answered, or null if unresolved. */
let resolvedAnthropicModel: string | null = null;

/**
 * Models that rejected `output_config.effort`, so it is not sent to them again.
 *
 * ⚠️ Not a nicety. `claude-haiku-4-5` routes these prompts perfectly well and
 * returns **HTTP 400 "This model does not support the effort parameter"** for
 * the parameter alone. Probed live: with `effort` sent unconditionally, setting
 * `ANTHROPIC_MODEL=claude-haiku-4-5` did not make intake cheaper — it disabled
 * the primary provider outright and ran every message through Gemini, reporting
 * nothing unusual anywhere. An operator dialling down cost would have silently
 * switched vendors.
 *
 * So an unsupported PARAMETER retries the same model without it, and only an
 * unsupported MODEL advances the chain. Conflating the two is what turns a
 * configuration change into an outage.
 */
const effortUnsupported = new Set<string>();

/**
 * Does this failure mean "this model will not serve me", as opposed to "this
 * request was wrong" or "the API is having a moment"?
 *
 * Deliberately narrow. A 429 is an ACCOUNT rate limit on Anthropic rather than a
 * per-model one, and a 529 is the API overloaded as a whole — walking the chain
 * against either just multiplies one outage by three. Only a model that is
 * genuinely unknown or retired is worth replacing.
 */
function isUnknownAnthropicModel(status: number, message: string): boolean {
  if (status === 404) return true;
  return (
    status === 400 &&
    /model/i.test(message) &&
    /not.{0,20}(found|exist|available|supported)|invalid/i.test(message)
  );
}

function isEffortUnsupported(status: number, message: string): boolean {
  return status === 400 && /effort/i.test(message);
}

/**
 * Ask Anthropic what exists, and rank cheapest-capable first.
 *
 * Returns a LIST rather than a pick, for the same reason the Gemini path does:
 * the caller has to try them. Sonnet and Haiku lead because this is a classifier
 * emitting one small JSON object, and the cheapest capable thing is the right
 * thing.
 */
async function discoverAnthropicModels(): Promise<string[]> {
  try {
    const page = await anthropic.models.list({ limit: 20 });
    const ids = (page.data ?? []).map((m) => m.id).filter(Boolean);
    const rank = (id: string) =>
      /sonnet/i.test(id) ? 0 : /haiku/i.test(id) ? 1 : /opus/i.test(id) ? 2 : 3;
    return [...ids].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  } catch {
    return [];
  }
}

export const anthropicProvider: Provider = {
  name: "anthropic",
  configured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async complete({ system, user, maxTokens }) {
    const pinned = process.env.ANTHROPIC_MODEL?.trim();
    // A pinned model is tried alone — an operator naming one is not asking for a
    // second opinion. Otherwise start from whatever last answered.
    const attempts = pinned
      ? [pinned]
      : resolvedAnthropicModel
        ? [resolvedAnthropicModel, ...ANTHROPIC_CANDIDATES.filter((m) => m !== resolvedAnthropicModel)]
        : [...ANTHROPIC_CANDIDATES];

    let lastError = "no usable Anthropic model";

    const ask = (model: string, withEffort: boolean) =>
      anthropic.messages.create({
        model,
        // ⚠️ Thinking tokens are charged to `max_tokens` on current models, and
        // callers here ask for one small JSON object. A 200-token ceiling would
        // be spent on reasoning and return a truncated `{` — exactly the failure
        // already documented for Gemini below, where a 195/200 split returned
        // three characters. A floor, not a budget: the answer is still tiny, and
        // an unspent ceiling costs nothing.
        max_tokens: Math.max(maxTokens, 2048),
        ...(withEffort ? { output_config: { effort: ANTHROPIC_EFFORT } } : {}),
        system,
        messages: [{ role: "user", content: user }],
      });

    /** Try each model in turn. Returns a result, or null to keep looking. */
    const walk = async (models: string[]): Promise<LlmResult | null> => {
      for (const model of models) {
        // Two passes at most: with effort, then without if the model said no.
        for (let pass = 0; pass < 2; pass++) {
          const withEffort = pass === 0 && !effortUnsupported.has(model);
          try {
            const response = await ask(model, withEffort);
            // A thinking block arrives first on models that reason; the answer
            // is the text block, which is why this searches rather than indexes.
            const block = response.content.find((b) => b.type === "text");
            if (!block || block.type !== "text") {
              lastError = `${model} answered with no text block`;
              break;
            }
            resolvedAnthropicModel = model;
            return { ok: true, text: block.text, provider: "anthropic" };
          } catch (error) {
            const status = error instanceof Anthropic.APIError ? (error.status ?? 0) : 0;
            const message = error instanceof Error ? error.message : String(error);
            lastError = status ? `${status} ${message.slice(0, 160)}` : message.slice(0, 160);

            // The parameter, not the model. Remember, and retry the same model.
            if (pass === 0 && withEffort && isEffortUnsupported(status, message)) {
              effortUnsupported.add(model);
              console.warn(`${model} does not accept output_config.effort — retrying without it.`);
              continue;
            }
            // The model itself is gone. Next candidate.
            if (isUnknownAnthropicModel(status, message)) {
              if (resolvedAnthropicModel === model) resolvedAnthropicModel = null;
              break;
            }
            // Anything else — a rate limit, an overload, a network fault — is
            // not this model's fault, and proving that on two more names would
            // spend the caller's whole budget. Hand it to the fallback provider.
            return { ok: false, provider: "anthropic", error: lastError };
          }
        }
      }
      return null;
    };

    const first = await walk(attempts);
    if (first) return first;

    // Every candidate was refused as unknown. Ask what exists and TRY each.
    // Skipped when a model was pinned: quietly using a different one is exactly
    // what an explicit setting forbids.
    if (!pinned) {
      const discovered = await discoverAnthropicModels();
      const second = await walk(discovered.filter((m) => !attempts.includes(m)));
      if (second) return second;
    }

    return { ok: false, provider: "anthropic", error: lastError };
  },
};

// ── Gemini (fallback) ──────────────────────────────────────────────────────
//
// The REST shape: a system instruction is its own field rather than a leading
// message, and the answer is nested under candidates[0].content.parts[0].text.
// A 4xx/5xx returns `ok: false` like any other failure, so an unconfigured or
// rejected fallback lands on the same safe default the caller already had.
//
// ── Choosing a Gemini model, and surviving the next retirement ─────────────
//
// ⚠️ `gemini-2.0-flash` was retired by Google, confirmed live: HTTP 404 "This
// model is no longer available". That is the exact failure this fallback exists
// to survive, arriving from the fallback itself — worse than a primary outage,
// because the safety net was the thing that tore.
//
// 📌 A better-chosen hardcoded name does not fix it. ANY name goes stale, and
// the failure is always silent until the day the primary is down. Two things
// found by probing the live API make that concrete, and neither was guessable:
//
//   • `gemini-2.5-flash` and `gemini-2.5-pro` are ALSO 404 — "no longer
//     available to new users". A chain of plausible current names was, in fact,
//     entirely dead.
//   • **ListModels lies.** It reports both of those as supporting
//     generateContent. Asking the API what exists is therefore not enough; a
//     discovered model has to be TRIED before it is believed.
//
// So the model is resolved, not declared:
//   1. `GEMINI_MODEL` if set — explicit configuration wins and is never
//      second-guessed.
//   2. A short chain, verified live at the time of writing (see below).
//   3. Discovery, each candidate actually CALLED rather than trusted.
//
// The winner is cached for the process, so a dead name is probed once rather
// than on every webhook.
const GEMINI_CANDIDATES = [
  // Newest that answers on this key — the "current high free version".
  "gemini-3.5-flash",
  // Rolling alias: Google repoints it, so it outlives snapshots. Second rather
  // than first because it currently resolves to an older generation.
  "gemini-flash-latest",
  "gemini-3-flash-preview",
];

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** Cached across calls: the model that last answered, or null if unresolved. */
let resolvedGeminiModel: string | null = null;

/**
 * Whether a failure means "this model will not serve me" as opposed to "this
 * request did not work right now".
 *
 * ⚠️ The distinction decides whether to try the next candidate, and it is wrong
 * in both directions if taken loosely. Advancing on a 5xx would burn the whole
 * chain against a transient outage that affects every model equally; NOT
 * advancing on a 404 is the bug this block exists to fix.
 *
 * All three of these answer immediately, so chaining on them costs no real
 * time — a timeout does not chain, which keeps the caller (a webhook) inside
 * its budget.
 *   404 — retired or unknown.
 *   400 — the request is not valid FOR THIS MODEL. `gemini-flash-lite-latest`
 *         rejects `thinkingConfig` with exactly this, live.
 *   429 — this model's own quota. Free-tier pro models exhaust while flash
 *         models still answer, so another candidate is genuinely worth trying.
 *   503 — Google says this one PER MODEL: "This model is currently
 *         experiencing high demand." Seen live from `gemini-3.5-flash` in the
 *         same minute `gemini-flash-latest` answered normally, which is what
 *         makes it a reason to move on rather than a reason to give up.
 *
 * A 500 is deliberately absent: that is Google's end failing generally, and
 * walking the chain against it just multiplies one outage by four.
 */
function shouldTryNextModel(status: number): boolean {
  return status === 404 || status === 400 || status === 429 || status === 503;
}

/**
 * Ask Google what exists, and RETURN A LIST rather than a pick — because the
 * list cannot be trusted, every entry has to be attempted by the caller.
 * Flash models first: this is a classifier emitting one small JSON object, and
 * the cheapest capable thing is the right thing.
 */
async function discoverGeminiModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${GEMINI_API}/models`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const usable = (json.models ?? [])
      .filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes("generateContent"))
      // The API returns "models/gemini-x"; the generateContent path wants the bare id.
      .map((m) => m.name!.replace(/^models\//, ""))
      // Anything whose name announces a non-text job. A TTS or image model
      // supports generateContent and will not classify a maintenance request.
      .filter((n) => !/tts|image|embedding|aqa|veo|imagen|banana/i.test(n));

    const flash = usable.filter((n) => /flash/i.test(n));
    const rest = usable.filter((n) => !/flash/i.test(n));
    // A handful, not all 37 — the point is to recover, not to exhaust a quota
    // walking a list on a webhook's clock.
    return [...flash, ...rest].slice(0, 4);
  } catch {
    return [];
  }
}

export const geminiProvider: Provider = {
  name: "gemini",
  configured: () => Boolean(process.env.GEMINI_API_KEY),
  async complete({ system, user, maxTokens }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { ok: false, provider: "gemini", error: "GEMINI_API_KEY is not set" };

    const pinned = process.env.GEMINI_MODEL?.trim();
    // A pinned model is tried alone — an operator naming one is not asking for
    // a second opinion. Otherwise start from whatever last answered.
    const attempts = pinned
      ? [pinned]
      : resolvedGeminiModel
        ? [resolvedGeminiModel, ...GEMINI_CANDIDATES.filter((m) => m !== resolvedGeminiModel)]
        : [...GEMINI_CANDIDATES];

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        // These prompts all ask for one small JSON object. Low temperature
        // keeps a classifier a classifier.
        temperature: 0.2,
        responseMimeType: "application/json",
        // ⚠️ THINKING OFF, and this is not a preference. Current Gemini flash
        // models reason by default and charge it to `maxOutputTokens` — probed
        // live, a 200-token budget spent 195 on thoughts and returned the three
        // characters "```", finishReason MAX_TOKENS. Callers here pass 120–300
        // (lib/triage, lib/inbound-router), so EVERY real classification would
        // have come back as truncated JSON: a fallback that answers with
        // garbage rather than failing cleanly, which is the worse of the two.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const ask = async (model: string) =>
      fetch(`${GEMINI_API}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
        // A fallback that hangs is not a fallback — the caller is a webhook
        // with a provider waiting on it.
        signal: AbortSignal.timeout(15_000),
      });

    const textFrom = (json: unknown) =>
      (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        ?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

    let lastError = "no usable Gemini model";

    /** Try each model in turn. Returns a result, or null to keep looking. */
    const walk = async (models: string[]) => {
      for (const model of models) {
        let res: Response;
        try {
          res = await ask(model);
        } catch (error) {
          // A timeout or network fault is not this model's fault, and proving
          // that on three more names would spend the caller's whole budget.
          lastError = error instanceof Error ? error.message : String(error);
          return { ok: false as const, provider: "gemini" as const, error: lastError };
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          lastError = `HTTP ${res.status} ${detail.slice(0, 160)}`;
          if (shouldTryNextModel(res.status)) {
            if (resolvedGeminiModel === model) resolvedGeminiModel = null;
            continue;
          }
          return { ok: false as const, provider: "gemini" as const, error: lastError };
        }

        const text = textFrom(await res.json().catch(() => null));
        if (!text) {
          // A 200 carrying no candidate is as useless as a retirement, and
          // some models answer exactly that way. Treated the same: move on
          // rather than reporting the fallback as broken.
          lastError = `${model} answered with no text`;
          if (resolvedGeminiModel === model) resolvedGeminiModel = null;
          continue;
        }

        resolvedGeminiModel = model;
        return { ok: true as const, text, provider: "gemini" as const };
      }
      return null;
    };

    const first = await walk(attempts);
    if (first) return first;

    // Every candidate refused. Ask Google what exists and TRY each — the list
    // is not trustworthy on its own. Skipped when a model was pinned: quietly
    // using a different one is exactly what an explicit setting forbids.
    if (!pinned) {
      const discovered = await discoverGeminiModels(key);
      const second = await walk(discovered.filter((m) => !attempts.includes(m)));
      if (second) return second;
      if (discovered.length === 0) {
        lastError = `every known model was refused and none could be discovered — last: ${lastError}`;
      }
    }

    return { ok: false, provider: "gemini", error: lastError };
  },
};

/**
 * Asks the primary, falls over to the fallback, and tells the caller which one
 * answered.
 *
 * ⚠️ `parse` is part of the contract, not a convenience. A provider that
 * returns 200 with unusable content has failed just as surely as one that
 * returns 500 — an overloaded model emitting prose instead of JSON used to
 * land on the safe default with the fallback never consulted. So failover is
 * driven by "did we get a USABLE answer", not by "did the HTTP call succeed".
 *
 * Providers are injectable so the failover itself can be tested without an
 * outage and without either key — see `verify-classifier-failover`.
 */
export async function completeWithFailover<T>(
  req: LlmRequest,
  parse: (text: string) => T | null,
  providers: Provider[] = [anthropicProvider, geminiProvider]
): Promise<{ value: T; provider: ProviderName } | { value: null; provider: "none" }> {
  const attempted: string[] = [];

  for (const provider of providers) {
    if (!provider.configured()) {
      attempted.push(`${provider.name}: not configured`);
      continue;
    }

    const result = await provider.complete(req);
    if (!result.ok) {
      attempted.push(`${provider.name}: ${result.error.slice(0, 120)}`);
      continue;
    }

    const parsed = parse(result.text);
    if (parsed === null) {
      attempted.push(`${provider.name}: returned an unusable answer`);
      continue;
    }

    // Worth a line when the primary did NOT answer: running on the fallback is
    // a state someone should be able to discover from the logs, not only from
    // a column.
    if (provider.name !== providers[0]?.name) {
      console.warn(`LLM failover: answered by ${provider.name}. Earlier: ${attempted.join(" | ")}`);
    }
    return { value: parsed, provider: provider.name };
  }

  console.error(`LLM unavailable — every provider failed. ${attempted.join(" | ")}`);
  return { value: null, provider: "none" };
}

/** For a settings screen or a health check: what is actually wired up. */
export function llmProviderStatus(): { primary: boolean; fallback: boolean } {
  return {
    primary: anthropicProvider.configured(),
    fallback: geminiProvider.configured(),
  };
}

export type ProviderHealth = {
  name: ProviderName;
  role: "primary" | "fallback";
  configured: boolean;
  reachable: boolean | null; // null = not probed, because not configured
  detail: string;
};

/**
 * Does each provider actually ANSWER right now?
 *
 * ⚠️ Deliberately not "is the key set". A key can be present and the provider
 * still unusable, and that is not hypothetical: the first real call made with
 * this build's own Gemini key came back
 * `429 GenerateRequestsPerDayPerProjectPerModel-FreeTier` — a free-tier daily
 * quota already exhausted. `configured()` was true throughout. A health screen
 * reporting "fallback: configured ✓" would have been accurate and useless: the
 * failover was not going to work, and nobody would learn that until the
 * outage it exists for.
 *
 * So this sends a real (tiny) prompt and reports what came back. It costs one
 * request per provider, which is why it is a button rather than something that
 * runs on every page render.
 */
export async function probeProviders(): Promise<ProviderHealth[]> {
  const probe: LlmRequest = {
    system: 'Reply with ONLY this JSON and nothing else: {"ok":true}',
    user: "ping",
    maxTokens: 20,
  };

  const check = async (p: Provider, role: "primary" | "fallback"): Promise<ProviderHealth> => {
    if (!p.configured()) {
      return {
        name: p.name,
        role,
        configured: false,
        reachable: null,
        detail:
          role === "fallback"
            ? "No API key set. Failover is skipped — an outage on the primary degrades to human review."
            : "No API key set.",
      };
    }
    const r = await p.complete(probe);
    if (r.ok) {
      return { name: p.name, role, configured: true, reachable: true, detail: "Answered normally." };
    }
    // A quota refusal is the one worth naming specifically, because it looks
    // like success from every other angle.
    const quota = /\b429\b|quota|rate.?limit/i.test(r.error);
    return {
      name: p.name,
      role,
      configured: true,
      reachable: false,
      detail: quota
        ? `Key accepted but the provider refused: quota or rate limit reached. ${r.error.slice(0, 140)}`
        : r.error.slice(0, 180),
    };
  };

  return Promise.all([check(anthropicProvider, "primary"), check(geminiProvider, "fallback")]);
}
