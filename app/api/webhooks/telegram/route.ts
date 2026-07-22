import { NextRequest, NextResponse } from "next/server";
import { classifyAndCreateTicket } from "@/lib/triage";
import { buildAcknowledgement } from "@/lib/acknowledgement";
import { sendCascade } from "@/lib/cascade";
import { verifyTelegramSecret } from "@/lib/webhook-security";

// Telegram doesn't require a GET verification handshake — POST only.
export async function POST(request: NextRequest) {
  const secret = verifyTelegramSecret(
    request.headers.get("x-telegram-bot-api-secret-token")
  );
  if (!secret.ok) {
    console.warn("Rejected Telegram webhook:", secret.reason);
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

  console.log("Incoming Telegram message:", { chatId, firstName, username, messageText });

  try {
    const ticket = await classifyAndCreateTicket(
      messageText,
      String(chatId),
      firstName ?? username ?? null,
      "telegram",
      process.env.DEMO_ORG_ID!
    );
    console.log("Ticket created:", ticket.id, ticket.category, ticket.urgency);

    // Acknowledge via the B8 cascade (Telegram channel here) — logged + audited.
    await sendCascade({
      orgId: process.env.DEMO_ORG_ID!,
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
