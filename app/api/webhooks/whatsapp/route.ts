import { NextRequest, NextResponse } from "next/server";
import { classifyAndCreateTicket } from "@/lib/triage";
import { buildAcknowledgement } from "@/lib/acknowledgement";
import { sendCascade } from "@/lib/cascade";

// Meta's webhook verification handshake (run once when you register the
// Callback URL in the Meta App Dashboard).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// Incoming message events. Classification is awaited before responding —
// Vercel serverless functions don't reliably run work after the response is
// sent (no background execution without a waitUntil primitive), and
// Anthropic's typical latency (a few seconds) is well inside Meta's retry
// window, so a synchronous await is the safer choice here.
export async function POST(request: NextRequest) {
  const payload = await request.json();
  console.log("WhatsApp webhook payload:", JSON.stringify(payload));

  const value = payload?.entry?.[0]?.changes?.[0]?.value;

  // Status-update payloads (sent/delivered/read receipts) carry `statuses`,
  // not `messages` — ignore them, there's nothing to triage.
  if (!value?.messages) {
    return new NextResponse("OK", { status: 200 });
  }

  const message = value.messages[0];
  const senderWaId = message.from;
  const messageText = message.text?.body ?? "";
  const senderName = value.contacts?.[0]?.profile?.name ?? null;

  console.log("Incoming WhatsApp message:", { senderWaId, messageText });

  try {
    const ticket = await classifyAndCreateTicket(
      messageText,
      senderWaId,
      senderName,
      "whatsapp",
      process.env.DEMO_ORG_ID!
    );
    console.log("Ticket created:", ticket.id, ticket.category, ticket.urgency);

    // Acknowledge via the B8 cascade (WhatsApp primary here) — logged + audited.
    await sendCascade({
      orgId: process.env.DEMO_ORG_ID!,
      entityType: "ticket",
      entityId: ticket.id,
      message: buildAcknowledgement(ticket),
      whatsapp: senderWaId,
    });
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}
