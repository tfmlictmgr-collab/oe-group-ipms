import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase/admin";

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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function parseClassification(rawText: string): Classification {
  try {
    const stripped = rawText
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    const parsed = JSON.parse(stripped);
    return {
      category: parsed.category ?? FALLBACK_CLASSIFICATION.category,
      urgency: parsed.urgency ?? FALLBACK_CLASSIFICATION.urgency,
      summary: parsed.summary ?? null,
      property_or_unit: parsed.property_or_unit ?? null,
      requires_human_review: parsed.requires_human_review ?? true,
    };
  } catch {
    return FALLBACK_CLASSIFICATION;
  }
}

// Pure classification: message in → Classification out, no DB write. Used by
// both the live intake path and the accuracy harness (Week 2 measurement).
export async function classifyMessage(
  messageText: string
): Promise<Classification> {
  const systemPrompt = loadSystemPrompt();
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: messageText }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock
      ? parseClassification(textBlock.text)
      : FALLBACK_CLASSIFICATION;
  } catch (error) {
    console.error("Claude classification failed:", error);
    return FALLBACK_CLASSIFICATION;
  }
}

export type { Classification };

export async function classifyAndCreateTicket(
  messageText: string,
  chatId: string,
  senderName: string | null,
  channel: "whatsapp" | "telegram",
  orgId: string
) {
  const classification = await classifyMessage(messageText);

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
