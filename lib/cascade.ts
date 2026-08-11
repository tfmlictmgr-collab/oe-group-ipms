import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase/admin";
import {
  sendReply, whatsappSenderForOrg, telegramSenderForOrg,
  type WhatsAppSender, type TelegramButton,
} from "./notify";
import { mayContact } from "./channel-consent";

// B8 notification cascade (server-side only). Attempts channels in the required
// order — WhatsApp → SMS → Email — stopping at the first success. Telegram runs
// in parallel for opt-in recipients. Every attempt (sent / failed / skipped) is
// written to `notifications`, which mirrors to the immutable audit_log.
//
// SMS (Africa's Talking) and Email (Resend) are stubbed when no provider keys
// are configured — the attempt is still logged as `skipped` so the fallback is
// visible and auditable, per the Day 13 spec.

export type CascadeTarget = {
  orgId: string;
  /**
   * What the message is ABOUT. `conversation` covers a reply that belongs to no
   * record — a greeting, or an answer to someone with nothing open. Filing those
   * as `ticket` with a null id put entries in the trail claiming to concern a
   * request that does not exist.
   */
  entityType: "ticket" | "payment" | "service_charge" | "conversation";
  entityId: string | null;
  message: string;
  // Whatever contact points are known for the recipient:
  whatsapp?: string | null; // WhatsApp phone id / msisdn
  /**
   * The number to answer FROM. Supplied when replying to an inbound message, so
   * the reply leaves on the number the person actually wrote to. Omitted for
   * proactive sends, which resolve the org's own number instead.
   */
  whatsappSender?: WhatsAppSender | null;
  /**
   * Who this is going to, when they are a portal user. Required to send a
   * BUSINESS-INITIATED WhatsApp message, because consent is recorded against a
   * person (0148) and cannot be checked from a bare phone number.
   *
   * Omitted for replies (where `whatsappSender` is set instead) and for
   * recipients who have no user account — a vendor contact reached only through
   * `vendors.contact_phone`. In the latter case WhatsApp is SKIPPED rather than
   * attempted; see `tryWhatsApp`.
   */
  recipientUserId?: string | null;
  phone?: string | null; // for SMS
  email?: string | null;
  telegram?: string | null; // chat id (parallel, opt-in)
  /** Tappable actions to attach to the Telegram message, if any. */
  telegramButtons?: TelegramButton[][];
};

type Attempt = { status: "sent" | "failed" | "skipped"; detail: string };

async function tryWhatsApp(
  to: string,
  message: string,
  sender: WhatsAppSender | null,
  /**
   * True when this is a REPLY inside a conversation the person started. Replies
   * need no consent record — they messaged us, on the number they chose, about
   * something they raised. Everything else is business-initiated and gated.
   */
  isReply: boolean,
  recipientUserId: string | null | undefined
): Promise<Attempt> {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    return { status: "skipped", detail: "stubbed: no WhatsApp credentials" };
  }

  // ── The consent gate (0148) ──────────────────────────────────────────────
  // Business-initiated only. Fails CLOSED: no recorded consent, no send. The
  // cost of that is this ATTEMPT being skipped, after which the cascade falls
  // through to SMS and email — so the person still receives the notice, just
  // not on a channel we cannot prove they agreed to. The cost of failing open
  // is an unlawful disclosure under NDPA and a WhatsApp policy breach against
  // the number both brands depend on for inbound.
  if (!isReply) {
    if (!recipientUserId) {
      return {
        status: "skipped",
        detail: "no WhatsApp consent on record for this recipient (not a portal user)",
      };
    }
    if (!(await mayContact(recipientUserId, "whatsapp", to))) {
      return {
        status: "skipped",
        detail: "recipient has not consented to WhatsApp, or consent was given for a different number",
      };
    }
  }
  // An org with no number of its own is SKIPPED, not sent from someone else's.
  // The cascade then falls through to SMS and email, which is the B8 behaviour
  // for an unavailable channel — and far better than the recipient hearing from
  // a brand they have never dealt with.
  if (!sender) {
    return {
      status: "skipped",
      detail: "no WhatsApp number registered for this organisation",
    };
  }
  try {
    await sendReply("whatsapp", to, message, sender);
    return { status: "sent", detail: `delivered via WhatsApp from ${sender.phoneNumberId}` };
  } catch (e) {
    return { status: "failed", detail: e instanceof Error ? e.message : "WhatsApp send failed" };
  }
}

async function trySms(to: string): Promise<Attempt> {
  if (!process.env.AFRICASTALKING_API_KEY) {
    return { status: "skipped", detail: `stubbed: no SMS provider (would SMS ${to})` };
  }
  // Live Africa's Talking integration is a Phase-1 item.
  return { status: "skipped", detail: "SMS provider not yet integrated" };
}

async function tryEmail(to: string, message: string): Promise<Attempt> {
  if (!process.env.RESEND_API_KEY) {
    return { status: "skipped", detail: `stubbed: no Resend key (would email ${to})` };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "OE Group <noreply@oegroup.example>",
        to,
        subject: "OE Group — notification",
        text: message,
      }),
    });
    if (!res.ok) {
      return { status: "failed", detail: `Resend ${res.status}: ${await res.text()}` };
    }
    return { status: "sent", detail: "delivered via Resend" };
  } catch (e) {
    return { status: "failed", detail: e instanceof Error ? e.message : "email send failed" };
  }
}

async function tryTelegram(
  orgId: string,
  chatId: string,
  message: string,
  buttons?: TelegramButton[][]
): Promise<Attempt> {
  // Resolved per ORG, not from a single environment variable. With one bot per
  // brand, a shared token means every reply arrives from whichever bot that
  // variable named — the same cross-brand fault WhatsApp had.
  const botToken = await telegramSenderForOrg(orgId);
  if (!botToken) {
    return { status: "skipped", detail: "no Telegram bot registered for this organisation" };
  }
  try {
    await sendReply("telegram", chatId, message, null, botToken, buttons);
    return { status: "sent", detail: "delivered via Telegram" };
  } catch (e) {
    return { status: "failed", detail: e instanceof Error ? e.message : "Telegram send failed" };
  }
}

async function log(
  target: CascadeTarget,
  cascadeId: string,
  channel: string,
  recipient: string | null,
  attempt: Attempt,
  order: number
) {
  await supabaseAdmin.from("notifications").insert({
    org_id: target.orgId,
    cascade_id: cascadeId,
    channel,
    recipient,
    status: attempt.status,
    detail: attempt.detail,
    entity_type: target.entityType,
    entity_id: target.entityId,
    attempt_order: order,
  });
}

export async function sendCascade(
  target: CascadeTarget
): Promise<{ cascadeId: string; delivered: boolean }> {
  const cascadeId = randomUUID();
  let delivered = false;
  let order = 0;

  // Primary → SMS → Email, stopping at the first success.
  if (target.whatsapp) {
    order++;
    // Answer on the number that received the message; otherwise the org's own.
    // Never a global default — that is what crossed the brands.
    const sender = target.whatsappSender ?? (await whatsappSenderForOrg(target.orgId));
    // `whatsappSender` is supplied only when replying to an inbound message —
    // the type says so, and that makes it the honest discriminator for "did
    // they speak first," rather than adding a second flag that could disagree
    // with it.
    const a = await tryWhatsApp(
      target.whatsapp,
      target.message,
      sender,
      Boolean(target.whatsappSender),
      target.recipientUserId
    );
    await log(target, cascadeId, "whatsapp", target.whatsapp, a, order);
    if (a.status === "sent") delivered = true;
  }
  if (!delivered && target.phone) {
    order++;
    const a = await trySms(target.phone);
    await log(target, cascadeId, "sms", target.phone, a, order);
    if (a.status === "sent") delivered = true;
  }
  if (!delivered && target.email) {
    order++;
    const a = await tryEmail(target.email, target.message);
    await log(target, cascadeId, "email", target.email, a, order);
    if (a.status === "sent") delivered = true;
  }

  // Telegram runs in parallel for opt-in recipients (not part of the fallback).
  if (target.telegram) {
    order++;
    const a = await tryTelegram(target.orgId, target.telegram, target.message, target.telegramButtons);
    await log(target, cascadeId, "telegram", target.telegram, a, order);
  }

  return { cascadeId, delivered };
}
