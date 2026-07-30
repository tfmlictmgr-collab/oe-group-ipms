import { NextRequest, NextResponse } from "next/server";
import { handleInboundMessage } from "@/lib/handle-inbound";
import { sendCascade } from "@/lib/cascade";
import { checkRateLimit, clientIp, INTAKE_LIMITS } from "@/lib/rate-limit";
import { resolveOrgForChannel } from "@/lib/channel-routing";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telegramSenderForOrg, sendTelegram, answerTelegramCallback } from "@/lib/notify";

// Telegram doesn't require a GET verification handshake — POST only.
export async function POST(request: NextRequest) {
  // Coarse abuse shield: cap raw volume per source IP before any work. 200 on
  // trip so Telegram doesn't retry-storm; fail-open if Redis is unconfigured.
  const ipGate = await checkRateLimit(
    "tg-ip",
    clientIp(request.headers),
    INTAKE_LIMITS.coarsePerIp.limit,
    INTAKE_LIMITS.coarsePerIp.window
  );
  if (!ipGate.allowed) {
    console.warn("Rate limited Telegram source IP (coarse)");
    return new NextResponse("OK", { status: 200 });
  }

  // The per-bot secret token is BOTH auth and route key. Telegram echoes the
  // secret_token set on setWebhook as this header. A token that matches a
  // channel_routes row identifies the org AND proves the request is from that
  // bot's webhook (only Telegram and we know the token). No match → forged or
  // an unregistered bot → reject.
  const headerToken = request.headers.get("x-telegram-bot-api-secret-token");
  if (!headerToken) {
    console.warn("Rejected Telegram webhook: missing secret token");
    return new NextResponse("Forbidden", { status: 403 });
  }
  const route = await resolveOrgForChannel("telegram", headerToken);
  if (!route) {
    console.warn("Rejected Telegram webhook: unknown secret token (no route)");
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: { message?: Record<string, unknown>; callback_query?: Record<string, unknown> };
  try {
    payload = await request.json();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // ── A tapped button ──────────────────────────────────────────────────────
  if (payload.callback_query) {
    await handleCallback(payload.callback_query, route.orgId);
    return new NextResponse("OK", { status: 200 });
  }

  const message = payload?.message as
    | {
        text?: string;
        chat?: { id?: number };
        from?: { first_name?: string; username?: string };
      }
    | undefined;
  if (!message?.text) {
    return new NextResponse("OK", { status: 200 });
  }

  const chatId = message.chat?.id;
  const firstName = message.from?.first_name;
  const username = message.from?.username;
  const messageText = message.text;

  console.log("Incoming Telegram message:", {
    chatId,
    firstName,
    username,
    messageText,
    org: route.label ?? route.orgId,
  });

  // Per-sender burst cap on the expensive classify+write+reply path.
  const senderGate = await checkRateLimit(
    "tg-sender",
    String(chatId),
    INTAKE_LIMITS.perSender.limit,
    INTAKE_LIMITS.perSender.window
  );
  if (!senderGate.allowed) {
    console.warn("Rate limited Telegram sender:", chatId);
    return new NextResponse("OK", { status: 200 });
  }

  try {
    // Same routing as WhatsApp: this may be a new request, a follow-up, a
    // priority correction or a status question. Only the transport differs.
    const outcome = await handleInboundMessage({
      orgId: route.orgId,
      channel: "telegram",
      senderRef: String(chatId),
      senderName: firstName ?? username ?? null,
      messageText,
    });
    console.log("Handled:", outcome.intent, outcome.ticketId ?? "(no ticket)");

    if (!outcome.reply) {
      return new NextResponse("OK", { status: 200 });
    }

    // Buttons only where there is a ticket to act on, and only when the request
    // has just been raised — offering "it's urgent" on a status answer would be
    // noise.
    const buttons =
      outcome.intent === "new_request" && outcome.ticketId
        ? [[
            { label: "📋 Check status", data: `status:${outcome.ticketId}` },
            { label: "🚨 It's urgent", data: `urgent:${outcome.ticketId}` },
          ]]
        : undefined;

    await sendCascade({
      orgId: route.orgId,
      // A greeting has no ticket. Filing the reply against `entityType: "ticket"`
      // with a null id produced a notification that claimed to be about a request
      // that does not exist — harmless to the database, misleading to whoever
      // reads the trail.
      entityType: outcome.ticketId ? "ticket" : "conversation",
      entityId: outcome.ticketId,
      message: outcome.reply,
      telegram: String(chatId),
      telegramButtons: buttons,
    });
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}

/**
 * Handles a tapped inline button.
 *
 * `callback_data` comes back from a CLIENT and names a ticket. The secret token
 * already proved which org the bot belongs to, so every lookup is additionally
 * constrained to that org — otherwise someone could craft a callback naming a
 * ticket in another brand and read its status through the wrong bot. The button
 * is a suggestion; the org check is the authorisation.
 */
async function handleCallback(query: Record<string, unknown>, orgId: string) {
  const id = String(query.id ?? "");
  const data = String((query.data as string) ?? "");
  const chatId = ((query.message as Record<string, unknown>)?.chat as { id?: number })?.id;

  const botToken = await telegramSenderForOrg(orgId);
  if (!botToken || !chatId) return;

  const [action, ticketId] = data.split(":");
  if (!ticketId || !/^[0-9a-f-]{36}$/i.test(ticketId)) {
    await answerTelegramCallback(botToken, id, "That action is no longer available.");
    return;
  }

  const { data: ticket } = await supabaseAdmin
    .from("tickets")
    .select("id, status, category, urgency, assigned_vendor_id, assigned_to_user_id, created_at")
    .eq("id", ticketId)
    .eq("org_id", orgId)          // the authorisation, not the callback data
    .maybeSingle();

  if (!ticket) {
    await answerTelegramCallback(botToken, id, "That request could not be found.");
    return;
  }

  if (action === "status") {
    const assigned = ticket.assigned_vendor_id || ticket.assigned_to_user_id;
    const lines = [
      `Request ${ticket.id.slice(0, 8).toUpperCase()}`,
      `Status: ${String(ticket.status).replace(/_/g, " ")}`,
      `Category: ${ticket.category ?? "being classified"}`,
      `Priority: ${ticket.urgency ?? "normal"}`,
      assigned ? "It has been dispatched to a team." : "It is queued for dispatch.",
    ];
    await answerTelegramCallback(botToken, id);
    await sendTelegram(botToken, String(chatId), lines.join("\n"));
    return;
  }

  if (action === "urgent") {
    // Raises priority and flags for a person. Deliberately does NOT jump
    // straight to 'critical': that grade drives SLA and callout cost, and a
    // reporter marking their own request is a signal, not a decision.
    const { error } = await supabaseAdmin
      .from("tickets")
      .update({ urgency: "high", requires_human_review: true })
      .eq("id", ticket.id)
      .eq("org_id", orgId)
      .in("status", ["open", "assigned", "acknowledged", "in_progress"]);

    await answerTelegramCallback(
      botToken,
      id,
      error ? "Could not update that request." : "Flagged as urgent."
    );
    if (!error) {
      await sendTelegram(
        botToken,
        String(chatId),
        "Thanks — this has been raised in priority and flagged for a person to look at."
      );
    }
    return;
  }

  await answerTelegramCallback(botToken, id, "That action is no longer available.");
}
