import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { getGateway, type GatewayName } from "@/lib/gateway";

// Inbound payment webhooks. The order of operations here is the security
// design, so it is worth stating plainly:
//
//   1. rate limit          — a public endpoint
//   2. raw body            — the signature covers exact bytes; parsing first
//                            and re-serialising would break verification
//   3. verify signature    — proves WHO sent it. Fails CLOSED, always: unlike
//                            the abuse limiter, this is authentication, and an
//                            unsigned payment notification is worthless.
//   4. dedupe on event id  — a retry after a timeout is normal traffic
//   5. resolve the intent  — by OUR reference, not by anything in the payload
//   6. verify server-to-server — the ONLY trustworthy source of the amount.
//                            The signature proves the sender, not that the
//                            contents are true.
//   7. post idempotently   — record_collection returns the existing entry if
//                            one exists, so a double delivery cannot double-post
//
// Always answers 200 once the signature is valid. A non-2xx makes gateways
// retry, and retrying a message we have already understood adds load without
// changing the outcome; the stored event carries the real result.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gateway: string }> }
) {
  const { gateway } = await params;
  if (!["paystack", "flutterwave", "simulated"].includes(gateway)) {
    return new NextResponse("Unknown gateway", { status: 404 });
  }
  const name = gateway as GatewayName;

  const ipGate = await checkRateLimit("pay-webhook-ip", clientIp(request.headers), 120, "1 m");
  if (!ipGate.allowed) return new NextResponse("OK", { status: 200 });

  const rawBody = await request.text();

  const adapter = getGateway(name === "flutterwave" ? "USD" : "NGN");
  const signature =
    request.headers.get("x-paystack-signature") ??
    request.headers.get("verif-hash") ??
    request.headers.get("x-simulated-signature");

  if (!adapter.verifySignature(rawBody, signature)) {
    console.warn(`Rejected ${name} webhook: invalid signature`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const { eventId, eventType, reference } = extractEvent(name, payload);
  if (!reference) {
    await logEvent(name, eventId, eventType, null, true, payload, null, "no reference in payload");
    return new NextResponse("OK", { status: 200 });
  }

  // 4 — dedupe. The unique index does the work; a conflict means we have seen
  // this exact event before and there is nothing further to do.
  const { error: dupErr } = await supabaseAdmin.from("gateway_events").insert({
    gateway: name,
    event_id: eventId,
    event_type: eventType,
    reference,
    signature_valid: true,
    payload,
  });
  if (dupErr) {
    if (dupErr.message.includes("duplicate key")) {
      return new NextResponse("OK", { status: 200 });  // already handled
    }
    console.error("could not record gateway event:", dupErr.message);
  }

  // 5 — resolve by OUR reference.
  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, org_id, amount_expected, currency, ledger_entry_id, status")
    .eq("gateway_reference", reference)
    .maybeSingle();

  if (!intent) {
    await finishEvent(name, eventId, null, "no matching payment intent");
    return new NextResponse("OK", { status: 200 });
  }
  if (intent.ledger_entry_id) {
    await finishEvent(name, eventId, intent.id, "already posted");
    return new NextResponse("OK", { status: 200 });
  }

  // 6 — the amount comes from here, never from `payload`.
  const verified = await adapter.verifyTransaction(reference);
  if (!verified.ok || verified.status !== "success") {
    await supabaseAdmin
      .from("payment_intents")
      .update({ status: verified.status === "failed" ? "failed" : "pending" })
      .eq("id", intent.id);
    await finishEvent(name, eventId, intent.id, `not successful: ${verified.error ?? verified.status}`);
    return new NextResponse("OK", { status: 200 });
  }

  // The simulated adapter cannot know an amount, so our own expected figure is
  // used. That is the same rule the live adapters follow: never the payload.
  const amount = verified.amount ?? Number(intent.amount_expected);

  const { data: entryId, error: postErr } = await supabaseAdmin.rpc("record_collection", {
    p_intent_id: intent.id,
    p_amount_verified: amount,
    p_paid_at: verified.paidAt ?? new Date().toISOString(),
  });

  if (postErr) {
    console.error("collection posting failed:", postErr.message);
    await finishEvent(name, eventId, intent.id, `posting failed: ${postErr.message}`);
    // Still 200: the event is recorded and a retry would fail identically.
    return new NextResponse("OK", { status: 200 });
  }

  await finishEvent(name, eventId, intent.id, `posted entry ${entryId}`);
  return new NextResponse("OK", { status: 200 });
}

function extractEvent(name: GatewayName, payload: Record<string, unknown>) {
  const data = (payload.data ?? {}) as Record<string, unknown>;

  if (name === "paystack") {
    return {
      eventId: String(data.id ?? payload.id ?? `${data.reference ?? "unknown"}`),
      eventType: String(payload.event ?? "unknown"),
      reference: (data.reference as string) ?? null,
    };
  }
  if (name === "flutterwave") {
    return {
      eventId: String(data.id ?? payload.id ?? `${data.tx_ref ?? "unknown"}`),
      eventType: String(payload.event ?? payload["event.type"] ?? "unknown"),
      reference: (data.tx_ref as string) ?? (payload.txRef as string) ?? null,
    };
  }
  return {
    eventId: String(payload.event_id ?? payload.reference ?? "unknown"),
    eventType: String(payload.event ?? "charge.success"),
    reference: (payload.reference as string) ?? null,
  };
}

async function logEvent(
  gateway: GatewayName, eventId: string, eventType: string,
  reference: string | null, valid: boolean,
  payload: Record<string, unknown>, intentId: string | null, outcome: string
) {
  await supabaseAdmin.from("gateway_events").insert({
    gateway, event_id: eventId, event_type: eventType, reference,
    signature_valid: valid, payload, intent_id: intentId,
    processed_at: new Date().toISOString(), outcome,
  });
}

async function finishEvent(
  gateway: GatewayName, eventId: string, intentId: string | null, outcome: string
) {
  await supabaseAdmin
    .from("gateway_events")
    .update({ intent_id: intentId, processed_at: new Date().toISOString(), outcome })
    .eq("gateway", gateway)
    .eq("event_id", eventId);
}
