import { NextRequest, NextResponse } from "next/server";
import { classifyAndCreateTicket } from "@/lib/triage";
import { buildAcknowledgement } from "@/lib/acknowledgement";
import { sendCascade } from "@/lib/cascade";
import { checkRateLimit, clientIp, INTAKE_LIMITS } from "@/lib/rate-limit";
import { resolveOrgForChannel } from "@/lib/channel-routing";

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

  let payload: { message?: Record<string, unknown> };
  try {
    payload = await request.json();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
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
    const ticket = await classifyAndCreateTicket(
      messageText,
      String(chatId),
      firstName ?? username ?? null,
      "telegram",
      route.orgId
    );
    console.log("Ticket created:", ticket.id, ticket.category, ticket.urgency);

    // Acknowledge via the B8 cascade (Telegram channel here) — logged + audited.
    await sendCascade({
      orgId: route.orgId,
      entityType: "ticket",
      entityId: ticket.id,
      message: buildAcknowledgement(ticket),
      telegram: String(chatId),
    });
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}
