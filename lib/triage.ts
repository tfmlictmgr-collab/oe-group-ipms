import { readFileSync } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "./supabase/admin";
import { completeWithFailover, type ProviderName } from "./llm";

const PROMPT_DOC_PATH = path.join(
  process.cwd(),
  "docs",
  "AURA_Triage_Classification_Prompt.md"
);

function loadSystemPrompt(): string {
  const doc = readFileSync(PROMPT_DOC_PATH, "utf8");
  const match = doc.match(/```\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(
      `Could not find a fenced system prompt block in ${PROMPT_DOC_PATH}`
    );
  }
  return match[1];
}

type Classification = {
  category: "maintenance" | "billing" | "vendor" | "complaint" | "general";
  urgency: "critical" | "high" | "normal" | "low";
  summary: string | null;
  property_or_unit: string | null;
  requires_human_review: boolean;
};

const FALLBACK_CLASSIFICATION: Classification = {
  category: "general",
  urgency: "normal",
  summary: null,
  property_or_unit: null,
  requires_human_review: true,
};

/**
 * Returns null — not a default — when the text cannot be used.
 *
 * ⚠️ That distinction is the whole reason failover works. This used to return
 * `FALLBACK_CLASSIFICATION` on a parse failure, which is indistinguishable
 * from a successful classification of a vague message. Returning null lets
 * `completeWithFailover` see "this provider gave me nothing usable" and ask
 * the next one — an overloaded model answering with prose instead of JSON is
 * a failure, and it used to be silently accepted as an answer.
 */
function parseClassification(rawText: string): Classification | null {
  try {
    const stripped = rawText
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    const parsed = JSON.parse(stripped);
    // A JSON object that carries no category is not a classification; it is
    // something else that happened to parse.
    if (!parsed || typeof parsed !== "object" || !parsed.category) return null;
    return {
      category: parsed.category ?? FALLBACK_CLASSIFICATION.category,
      urgency: parsed.urgency ?? FALLBACK_CLASSIFICATION.urgency,
      summary: parsed.summary ?? null,
      property_or_unit: parsed.property_or_unit ?? null,
      requires_human_review: parsed.requires_human_review ?? true,
    };
  } catch {
    return null;
  }
}

/**
 * Pure classification: message in → Classification out, no DB write. Used by
 * both the live intake path and the accuracy harness (Week 2 measurement).
 *
 * Also reports WHICH provider answered, so `classified_by` (0113) can record
 * it. "Are we quietly running on the fallback?" must be answerable from the
 * data, not inferred from a quiet week.
 */
export async function classifyMessageWithProvider(
  messageText: string
): Promise<{ classification: Classification; provider: ProviderName }> {
  // ⚠️ Loading the prompt is INSIDE the try, not before it. It used to sit
  // above, so a failure here (missing file, bad fence, whatever the cause)
  // threw uncaught straight out of this function — past the very try/catch
  // built to survive "classification is unavailable" — and crashed ticket
  // creation instead of falling back to a human-reviewed ticket. That is
  // exactly what happened in production on 5 Aug. A prompt that cannot load
  // is the same failure mode as a model that cannot be reached: intake must
  // survive both.
  let systemPrompt: string;
  try {
    systemPrompt = loadSystemPrompt();
  } catch (error) {
    console.error("Could not load the classification prompt:", error);
    return { classification: FALLBACK_CLASSIFICATION, provider: "none" };
  }

  const { value, provider } = await completeWithFailover(
    { system: systemPrompt, user: messageText, maxTokens: 300 },
    parseClassification
  );

  return {
    classification: value ?? FALLBACK_CLASSIFICATION,
    provider,
  };
}

/** Back-compatible shape for callers that only want the classification. */
export async function classifyMessage(messageText: string): Promise<Classification> {
  const { classification } = await classifyMessageWithProvider(messageText);
  return classification;
}

export type { Classification };

export async function classifyAndCreateTicket(
  messageText: string,
  chatId: string,
  senderName: string | null,
  channel: "whatsapp" | "telegram",
  orgId: string
) {
  const { classification, provider } = await classifyMessageWithProvider(messageText);

  // Who wrote in, and about where.
  //
  // Without this the row carries no identity and no property, and the select
  // policy then hides it from everyone except a holder of `tickets.read_all` —
  // a tenant could not see their own WhatsApp request, and no Facility Manager
  // could see any of them. Resolution is org-scoped and refuses ambiguity, so a
  // number we do not recognise simply stays unresolved rather than being
  // attached to the nearest plausible person.
  let senderId: string | null = null;
  let propertyId: string | null = null;
  try {
    const { data: who } = await supabaseAdmin
      .rpc("resolve_chat_sender", { p_org_id: orgId, p_sender_ref: chatId })
      .maybeSingle<{ user_id: string | null; property_id: string | null }>();
    senderId = who?.user_id ?? null;
    propertyId = who?.property_id ?? null;
  } catch (error) {
    // Never block intake on this. An unresolved request is visible to whoever
    // holds `tickets.triage_unassigned`; a dropped request is visible to nobody.
    console.error("Could not resolve chat sender:", error);
  }

  const { data: ticket, error } = await supabaseAdmin
    .from("tickets")
    .insert({
      org_id: orgId,
      channel,
      channel_sender_ref: chatId,
      sender_id: senderId,
      property_id: propertyId,
      message_text: messageText,
      // Which model actually produced this (0113). 'none' means both providers
      // were unreachable and this row carries the safe human-review default —
      // recorded rather than inferred, so a degraded classifier is a query and
      // not a hunch.
      classified_by: provider,
      category: classification.category,
      urgency: classification.urgency,
      summary: classification.summary,
      property_or_unit: classification.property_or_unit,
      requires_human_review: classification.requires_human_review,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert ticket: ${error.message}`);
  }

  return ticket;
}
