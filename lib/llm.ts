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

// ⚠️ The model is the single largest lever on how well intake reads a message,
// and it was pinned to `claude-sonnet-4-6` — a generation behind — while the
// live WhatsApp transcript showed a question being filed as a work order. The
// prompts and the guards in `inbound-router.ts` do most of the work, but they
// are asking a model to make a judgement, and a better model makes it better.
//
// Overridable because the operator, not this file, should decide the
// cost/latency trade for a hot webhook path: every inbound message pays for
// this, and Meta retries anything slow. `ANTHROPIC_MODEL` takes any current id.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5";

// Low effort on purpose. These calls emit one small JSON object from a short
// message — the work is judgement, not reasoning depth, and a classifier that
// deliberates is a webhook that times out.
const ANTHROPIC_EFFORT =
  (process.env.ANTHROPIC_EFFORT?.trim() as "low" | "medium" | "high" | undefined) || "low";

export const anthropicProvider: Provider = {
  name: "anthropic",
  configured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async complete({ system, user, maxTokens }) {
    try {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        // ⚠️ Thinking tokens are charged to `max_tokens` on current models, and
        // callers here ask for one short JSON object. A 200-token ceiling would
        // be spent on reasoning and return a truncated `{` — which is exactly
        // the failure already documented for Gemini below, where a 195/200
        // split returned three characters. A floor, not a budget: the answer is
        // still tiny, and an unspent ceiling costs nothing.
        max_tokens: Math.max(maxTokens, 2048),
        output_config: { effort: ANTHROPIC_EFFORT },
        system,
        messages: [{ role: "user", content: user }],
      });
      const block = response.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        return { ok: false, provider: "anthropic", error: "no text block in response" };
      }
      return { ok: true, text: block.text, provider: "anthropic" };
    } catch (error) {
      return {
        ok: false,
        provider: "anthropic",
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
