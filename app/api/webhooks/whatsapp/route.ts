import { NextRequest, NextResponse } from "next/server";

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

// Incoming message events. Meta requires a fast 200 response — any real
// processing (Day 4's classifier) happens after we've already responded.
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
  const timestamp = message.timestamp;

  console.log("Incoming WhatsApp message:", { senderWaId, messageText, timestamp });

  return new NextResponse("OK", { status: 200 });
}
