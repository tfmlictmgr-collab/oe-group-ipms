import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase/admin";
import { sendReply, whatsappSenderForOrg, type WhatsAppSender } from "./notify";

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
  entityType: "ticket" | "payment" | "service_charge";
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
  phone?: string | null; // for SMS
  email?: string | null;
  telegram?: string | null; // chat id (parallel, opt-in)
};

type Attempt = { status: "sent" | "failed" | "skipped"; detail: string };

async function tryWhatsApp(
  to: string,
  message: string,
  sender: WhatsAppSender | null
): Promise<Attempt> {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    return { status: "skipped", detail: "stubbed: no WhatsApp credentials" };
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

async function tryTelegram(chatId: string, message: string): Promise<Attempt> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return { status: "skipped", detail: "stubbed: no Telegram token" };
  }
  try {
    await sendReply("telegram", chatId, message);
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
    const a = await tryWhatsApp(target.whatsapp, target.message, sender);
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
    const a = await tryTelegram(target.telegram, target.message);
    await log(target, cascadeId, "telegram", target.telegram, a, order);
  }

  return { cascadeId, delivered };
}
