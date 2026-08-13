import { NextRequest, NextResponse } from "next/server";
import { handleInboundMessage } from "@/lib/handle-inbound";
import { sendCascade } from "@/lib/cascade";
import { whatsappSenderForOrg, whatsappSenderForNumber } from "@/lib/notify";
import { verifyWhatsAppInbound } from "@/lib/webhook-security";
import { checkRateLimit, clientIp, INTAKE_LIMITS } from "@/lib/rate-limit";
import { resolveOrgForChannel, type ChannelRoute } from "@/lib/channel-routing";
import { supabaseAdmin } from "@/lib/supabase/admin";

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

  const rawBody = await request.text();

  // ⚠️ Two authentication schemes, decided by what the request carries.
  //
  // Per-channel webhook TOKEN (the live path — both brands run through
  // 360dialog as direct clients, who do not get a Platform Secret and
  // therefore send no signature of any kind; see webhook-security.ts). Present
  // on the URL each channel was configured with in the 360dialog Hub. It is
  // BOTH auth and route key, exactly as Telegram's secret token already is: a
  // token matching no row is forged or unregistered → reject (403), and once
  // matched the request IS authenticated — this path does not, and must not,
  // trust `metadata.phone_number_id` in the body for anything security-
  // relevant, since there is no signature backing it.
  //
  // HMAC signature (the fallback — a natively-registered Meta number, or a
  // BSP with a Platform Secret enabled). No token on the URL routes here.
  const webhookToken = new URL(request.url).searchParams.get("token");

  let route: ChannelRoute | null = null;
  if (webhookToken) {
    route = await resolveOrgForChannel("whatsapp", webhookToken);
    if (!route) {
      console.warn("Rejected WhatsApp webhook: unknown webhook token (no route)");
      return new NextResponse("Forbidden", { status: 403 });
    }
  } else {
    const sig = verifyWhatsAppInbound(rawBody, request.headers);
    if (!sig.ok) {
      console.warn("Rejected WhatsApp webhook:", sig.reason);
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  type WhatsAppMessage = {
    id?: string;
    from: string;
    type?: string;
    text?: { body?: string };
    // Each media type carries its OWN optional caption — WhatsApp does not
    // put it on a shared field. A voice note/sticker never has one.
    image?: { caption?: string };
    video?: { caption?: string };
    document?: { caption?: string };
  };

  const value = (payload as { entry?: { changes?: { value?: Record<string, unknown> }[] }[] })
    ?.entry?.[0]?.changes?.[0]?.value as
    | {
        metadata?: { phone_number_id?: string };
        messages?: WhatsAppMessage[];
        contacts?: { profile?: { name?: string } }[];
      }
    | undefined;

  // Status-update payloads (sent/delivered/read receipts) carry `statuses`,
  // not `messages` — ignore them, there's nothing to triage.
  if (!value?.messages) {
    return new NextResponse("OK", { status: 200 });
  }

  // A reaction (a tapped emoji on a PAST message, e.g. "👍") is not the
  // sender saying anything of their own — replying to it with "please
  // describe your issue" would be answering a message that was never asked.
  // Dropped before routing, signature/route already verified above.
  if (value.messages[0]?.type === "reaction") {
    return new NextResponse("OK", { status: 200 });
  }

  const phoneNumberId = value.metadata?.phone_number_id;

  if (!route) {
    // Only reached on the HMAC path — the token path already has its route.
    // The body was verified as Meta's above, so phone_number_id is trustworthy
    // here specifically. No route → drop (200): never fall back to a default
    // org (that's the collapse this replaces, and for money messages a
    // cross-brand leak).
    route = await resolveOrgForChannel("whatsapp", phoneNumberId);
    if (!route) {
      console.warn("No WhatsApp channel route for phone_number_id:", phoneNumberId);
      return new NextResponse("OK", { status: 200 });
    }
  }

  const message = value.messages[0];
  const senderWaId = message.from;
  // A caption on an image/video/document IS the sender's own words and is
  // used exactly like typed text. A sticker, a bare photo, a voice note, a
  // location pin — none of those carry one, and messageText stays "": the
  // empty-content guard in handle-inbound.ts is what turns that into a
  // gentle "tell me what's wrong" reply instead of a blank ticket (the
  // defect this same window found live in production — a sticker/voice-note
  // class message silently creating a content-less row).
  const messageText =
    message.text?.body ?? message.image?.caption ?? message.video?.caption ??
    message.document?.caption ?? "";
  const hasMedia = message.type != null && message.type !== "text";
  const senderName = value.contacts?.[0]?.profile?.name ?? null;

  // 🛑 THIRD-PARTY BOT SUPPRESSION FILTER
  // Intercepts recycled number traffic (Flutterwave bot) before it triggers AI classification or ticket creation.
  const isBotSpam = /flutterwave|welcome to our bot service|bot service/i.test(messageText);
  
  if (isBotSpam) {
    console.warn(`[SPAM SUPPRESSED] Dropped Flutterwave bot message from ${senderWaId}`);
    // Always return 200 OK so Meta/360dialog considers it delivered and doesn't retry
    return new NextResponse("OK", { status: 200 });
  }

  // ⚠️ Idempotency. WhatsApp/360dialog redeliver a webhook on any slow or
  // non-2xx response, on a backoff that can span hours — normal provider
  // behaviour, exactly like a payment gateway's retry (see gateway_events,
  // 0032). Without this, a redelivery of the SAME message was reprocessed as
  // if new and re-sent whatever reply we already sent: observed live, one
  // "Hi" produced the identical pleasantry reply six times over a day. The
  // unique index on (channel, event_id) does the actual work; a conflict just
  // means we have already answered this exact message.
  if (message.id) {
    const { error: dupErr } = await supabaseAdmin.from("chat_webhook_events").insert({
      channel: "whatsapp", event_id: message.id, org_id: route.orgId, sender_ref: senderWaId,
    });
    if (dupErr) {
      if (dupErr.message.includes("duplicate key")) {
        console.log("Duplicate WhatsApp delivery, already handled:", message.id);
        return new NextResponse("OK", { status: 200 });
      }
      console.error("Could not record chat webhook event:", dupErr.message);
    }
  }

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
      hasMedia,
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
      // Answer on the channel they wrote to. On the token path `route` already
      // names the exact channel (the token identifies it 1:1, same as
      // Telegram), so the org's own registered sender IS that channel's sender
      // — `whatsappSenderForOrg` is correct here, not a compromise, because
      // each org holds exactly one 360dialog channel today. On the HMAC path,
      // `phoneNumberId` is the authenticated identity instead, and
      // `whatsappSenderForNumber` answers the more exact question in case an
      // org ever holds more than one natively-registered number.
      whatsappSender: webhookToken
        ? await whatsappSenderForOrg(route.orgId)
        : phoneNumberId
          ? await whatsappSenderForNumber(phoneNumberId)
          : null,
    });
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}
