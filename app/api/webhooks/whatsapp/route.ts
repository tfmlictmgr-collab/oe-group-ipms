import { NextRequest, NextResponse } from "next/server";
import { handleInboundMessage } from "@/lib/handle-inbound";
import { sendCascade } from "@/lib/cascade";
import { verifyWhatsAppSignature } from "@/lib/webhook-security";
import { checkRateLimit, clientIp, INTAKE_LIMITS } from "@/lib/rate-limit";
import { resolveOrgForChannel } from "@/lib/channel-routing";

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
  // Coarse abuse shield first: cap raw request volume per source IP before we
  // spend any work on HMAC/JSON. Returns 200 (not 429) on trip so Meta doesn't
  // retry-storm — an over-limit flood is simply dropped. Fail-open if Redis is
  // unconfigured, so the demo/local intake is unaffected.
  const ipGate = await checkRateLimit(
    "wa-ip",
    clientIp(request.headers),
    INTAKE_LIMITS.coarsePerIp.limit,
    INTAKE_LIMITS.coarsePerIp.window
  );
  if (!ipGate.allowed) {
    console.warn("Rate limited WhatsApp source IP (coarse)");
    return new NextResponse("OK", { status: 200 });
  }

  // Raw body first: HMAC verification must run over the exact bytes Meta signed.
  const rawBody = await request.text();
  const sig = verifyWhatsAppSignature(
    rawBody,
    request.headers.get("x-hub-signature-256")
  );
  if (!sig.ok) {
    console.warn("Rejected WhatsApp webhook:", sig.reason);
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const value = (payload as { entry?: { changes?: { value?: Record<string, unknown> }[] }[] })
    ?.entry?.[0]?.changes?.[0]?.value as
    | {
        metadata?: { phone_number_id?: string };
        messages?: { from: string; text?: { body?: string } }[];
        contacts?: { profile?: { name?: string } }[];
      }
    | undefined;

  // Status-update payloads (sent/delivered/read receipts) carry `statuses`,
  // not `messages` — ignore them, there's nothing to triage.
  if (!value?.messages) {
    return new NextResponse("OK", { status: 200 });
  }

  // Route by the business number that RECEIVED the message. The payload is
  // already HMAC-verified as Meta's, so phone_number_id is trustworthy. No
  // route → drop (200): never fall back to a default org (that's the collapse
  // this replaces, and for money messages a cross-brand leak).
  const phoneNumberId = value.metadata?.phone_number_id;
  const route = await resolveOrgForChannel("whatsapp", phoneNumberId);
  if (!route) {
    console.warn("No WhatsApp channel route for phone_number_id:", phoneNumberId);
    return new NextResponse("OK", { status: 200 });
  }

  const message = value.messages[0];
  const senderWaId = message.from;
  const messageText = message.text?.body ?? "";
  const senderName = value.contacts?.[0]?.profile?.name ?? null;

  console.log("Incoming WhatsApp message:", {
    senderWaId,
    messageText,
    org: route.label ?? route.orgId,
  });

  // Per-sender burst cap: protects the expensive classify+write+reply path from
  // a single number looping or spamming. Generous for a human; drops (200) on trip.
  const senderGate = await checkRateLimit(
    "wa-sender",
    senderWaId,
    INTAKE_LIMITS.perSender.limit,
    INTAKE_LIMITS.perSender.window
  );
  if (!senderGate.allowed) {
    console.warn("Rate limited WhatsApp sender:", senderWaId);
    return new NextResponse("OK", { status: 200 });
  }

  try {
    // A message is not necessarily a new request. It may be more information
    // about one already open, a correction to the priority we assigned, or a
    // question about where it has got to — and until this router existed, every
    // one of those opened another ticket.
    const outcome = await handleInboundMessage({
      orgId: route.orgId,
      channel: "whatsapp",
      senderRef: senderWaId,
      senderName,
      messageText,
    });
    console.log("Handled:", outcome.intent, outcome.ticketId ?? "(no ticket)");

    if (!outcome.reply) {
      return new NextResponse("OK", { status: 200 });
    }

    // Acknowledge via the B8 cascade (WhatsApp primary here) — logged + audited.
    await sendCascade({
      orgId: route.orgId,
      // A greeting has no ticket. Filing the reply against `entityType: "ticket"`
      // with a null id produced a notification that claimed to be about a request
      // that does not exist — harmless to the database, misleading to whoever
      // reads the trail.
      entityType: outcome.ticketId ? "ticket" : "conversation",
      entityId: outcome.ticketId,
      message: outcome.reply,
      whatsapp: senderWaId,
      // Answer on the number they wrote to. `phoneNumberId` came from a payload
      // already HMAC-verified as Meta's, and it is the whole point: a person who
      // messaged OEA must hear back from OEA.
      whatsappSender: process.env.WHATSAPP_ACCESS_TOKEN && phoneNumberId
        ? { phoneNumberId, accessToken: process.env.WHATSAPP_ACCESS_TOKEN }
        : null,
    });
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}
