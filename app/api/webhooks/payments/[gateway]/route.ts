import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { getAdapterByName, getGatewayForOrg, type GatewayName } from "@/lib/gateway";

/**
 * The adapter whose credentials belong to THIS org, for verifying a webhook it
 * sent. Falls back to the platform adapter when the org has not connected its
 * own account — additive, so an unconfigured org behaves exactly as before.
 */
async function getAdapterForOrgWebhook(name: GatewayName, orgId: string) {
  if (name === "simulated") return getAdapterByName(name);
  const { getOrgCredential } = await import("@/lib/gateway/credentials");
  const cred = await getOrgCredential(orgId, name);
  if (!cred) return getAdapterByName(name);
  // Paystack signs with the SECRET key; Flutterwave with a separate hash. The
  // adapter takes whichever that gateway uses to verify.
  return getGatewayForOrg(orgId, name === "paystack" ? "NGN" : "USD");
}

// Inbound payment webhooks. The order of operations here is the security
// design, so it is worth stating plainly:
//
//   1. rate limit          — a public endpoint. Money moves here, so this is
//                            the one exception to lib/rate-limit.ts's
//                            documented fail-OPEN default: if Redis was
//                            configured and is now unreachable (`degraded`),
//                            this route refuses rather than going unguarded.
//                            An environment that never configured Upstash at
//                            all (`skipped` without `degraded` — local dev,
//                            the POC demo) is unaffected and behaves exactly
//                            as before.
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
  if (ipGate.degraded) {
    console.error(`pay-webhook rate limiter unavailable (Redis errored) — refusing ${name} webhook until it recovers`);
    return new NextResponse("Service Unavailable", { status: 503 });
  }
  if (!ipGate.allowed) return new NextResponse("OK", { status: 200 });

  const rawBody = await request.text();

  // Selected by the gateway that called us, which the URL tells us — never
  // inferred from a currency. A message must be verified with the credentials
  // of its actual sender.
  //
  // Throws when that gateway has no key: we then have no way to verify the
  // signature, so the only safe answer is to refuse. Caught rather than allowed
  // to become a 500 — an unhandled error makes gateways retry indefinitely, and
  // it hints at internal state to whoever is probing.
  // ⚠️ THE ORDERING PROBLEM, and why the org is read from an unverified body.
  //
  // With per-org merchant accounts (0156) the signature must be checked against
  // the SENDING org's secret — but which org sent it is only knowable from the
  // payload, which is not yet trustworthy. The reference carries an org tag for
  // exactly this: read it, resolve the org, fetch that org's secret, and only
  // then verify.
  //
  // Using an unverified field to CHOOSE A KEY is safe, and the distinction is
  // worth stating: a forged body naming another org's tag is verified against
  // that org's secret and fails. A wrong choice refuses, so the choice cannot be
  // exploited. Nothing else in this payload is trusted before the check below —
  // in particular the amount, which is re-verified against the gateway at step 5.
  //
  // A reference with no tag (minted before 0156, or an org that has not
  // connected its own account) resolves to null and verifies against the
  // platform key, exactly as it did before.
  let orgId: string | null = null;
  try {
    const peeked = JSON.parse(rawBody) as Record<string, unknown>;
    const peekedRef = extractEvent(name, peeked).reference;
    if (peekedRef) {
      const { orgFromPaymentReference } = await import("@/lib/gateway/credentials");
      orgId = await orgFromPaymentReference(peekedRef);
    }
  } catch {
    // Unparseable body: fall through to the platform key, which will refuse it
    // on signature or on the JSON parse below.
  }

  let adapter;
  try {
    adapter = orgId
      ? await getAdapterForOrgWebhook(name, orgId)
      : getAdapterByName(name);
  } catch {
    console.warn(`Rejected ${name} webhook: gateway not configured, cannot verify`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  const signature =
    request.headers.get("x-paystack-signature") ??
    request.headers.get("verif-hash") ??
    request.headers.get("x-simulated-signature");

  if (!adapter.verifySignature(rawBody, signature)) {
    console.warn(`Rejected ${name} webhook: invalid signature${orgId ? ` (org ${orgId})` : ""}`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const { eventId, eventType, reference } = extractEvent(name, payload);

  // ── Outbound: transfers ──────────────────────────────────────────────────
  // Money LEAVING is settled here, not when the instruction was accepted. A
  // transfer that came back `pending` has not moved anything yet, and posting it
  // then would record a payout that may still fail. Handled before the inbound
  // path because a transfer event has no payment intent to resolve.
  if (eventType.startsWith("transfer.")) {
    await handleTransferEvent(name, eventId, eventType, reference, payload);
    return new NextResponse("OK", { status: 200 });
  }

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

  // Every adapter returns the amount from its own server-side lookup. The
  // fallback is our invoiced figure — never the payload, under any adapter.
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

/**
 * Settles an outbound transfer from the gateway's own report.
 *
 * `reference` is OUR reference, echoed back — the same rule as collections: the
 * remittance is resolved by something we generated, never by anything the
 * payload chose. Posting is idempotent in `record_remittance_sent`, so a
 * redelivered success cannot pay twice or post twice.
 */
async function handleTransferEvent(
  gateway: GatewayName,
  eventId: string,
  eventType: string,
  reference: string | null,
  payload: Record<string, unknown>
) {
  await supabaseAdmin.from("gateway_events").insert({
    gateway, event_id: eventId, event_type: eventType, reference,
    signature_valid: true, payload,
  });

  if (!reference) {
    await finishEvent(gateway, eventId, null, "transfer event carried no reference");
    return;
  }

  const { data: remittance } = await supabaseAdmin
    .from("remittances")
    .select("id, status, ledger_entry_id")
    .eq("reference", reference)
    .maybeSingle();

  if (!remittance) {
    await finishEvent(gateway, eventId, null, "no matching remittance");
    return;
  }

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const transferCode = String(data.transfer_code ?? reference);

  if (eventType === "transfer.success") {
    if (remittance.ledger_entry_id) {
      await finishEvent(gateway, eventId, null, "already posted");
      return;
    }
    const { data: entryId, error } = await supabaseAdmin.rpc("record_remittance_sent", {
      p_id: remittance.id,
      p_transfer_code: transferCode,
    });
    await finishEvent(
      gateway, eventId, null,
      error ? `posting failed: ${error.message}` : `posted entry ${entryId}`
    );
    return;
  }

  // failed / reversed. A reversal after a successful posting is NOT handled
  // here: reversing money that has already been recorded as sent requires a
  // compensating ledger entry and a human decision, so it is left flagged
  // rather than quietly undone.
  if (remittance.ledger_entry_id) {
    await finishEvent(
      gateway, eventId, null,
      `${eventType} arrived AFTER posting — needs a reversing entry and review`
    );
    return;
  }

  const { error } = await supabaseAdmin.rpc("record_remittance_outcome", {
    p_id: remittance.id,
    p_status: "failed",
    p_message: String(data.reason ?? data.message ?? eventType),
  });
  await finishEvent(
    gateway, eventId, null,
    error ? `could not record outcome: ${error.message}` : `recorded ${eventType}`
  );
}

function extractEvent(name: GatewayName, payload: Record<string, unknown>) {
  const data = (payload.data ?? {}) as Record<string, unknown>;

  if (name === "paystack") {
    return {
      eventId: String(data.id ?? payload.id ?? `${data.reference ?? "unknown"}`),
      eventType: String(payload.event ?? "unknown"),
      // Charges and transfers both echo our reference here.
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
