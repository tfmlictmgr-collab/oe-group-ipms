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

export const anthropicProvider: Provider = {
  name: "anthropic",
  configured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async complete({ system, user, maxTokens }) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
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
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";

export const geminiProvider: Provider = {
  name: "gemini",
  configured: () => Boolean(process.env.GEMINI_API_KEY),
  async complete({ system, user, maxTokens }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { ok: false, provider: "gemini", error: "GEMINI_API_KEY is not set" };

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              maxOutputTokens: maxTokens,
              // These prompts all ask for one small JSON object. Low
              // temperature keeps a classifier a classifier.
              temperature: 0.2,
              responseMimeType: "application/json",
            },
          }),
          // A fallback that hangs is not a fallback — the caller is a webhook
          // with a provider waiting on it.
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, provider: "gemini", error: `HTTP ${res.status} ${body.slice(0, 160)}` };
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return { ok: false, provider: "gemini", error: "no text in response" };
      return { ok: true, text, provider: "gemini" };
    } catch (error) {
      return {
        ok: false,
        provider: "gemini",
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
