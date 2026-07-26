"use server";

import crypto from "node:crypto";
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { gatewayConfigured, isProduction } from "@/lib/gateway";

/**
 * Stands in for a card being charged.
 *
 * It writes the gateway's own record of the charge, then sends a properly
 * signed webhook to our public endpoint — over HTTP, to our own URL, exactly as
 * Paystack would. Nothing here posts to the ledger directly: the signature
 * check, the dedupe, the server-to-server verification and the idempotent
 * posting all run for real. That is what makes the simulation worth having.
 */
export async function simulatePayment(
  reference: string,
  amount: number
): Promise<{ message: string; returnTo: string }> {
  if (isProduction()) throw new Error("Not available.");

  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, amount_expected, currency, gateway, ledger_entry_id")
    .eq("gateway_reference", reference)
    .maybeSingle();

  if (!intent) throw new Error("That payment reference is not recognised.");
  if (intent.gateway !== "simulated" || gatewayConfigured(intent.currency)) {
    throw new Error("This payment must be made through the live gateway.");
  }
  if (intent.ledger_entry_id) {
    return { message: "Already received.", returnTo: `/dashboard/ledger/collections?ref=${reference}` };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter an amount greater than zero.");
  }

  // The gateway's record. Verification reads this, not the message below.
  const { error: chargeErr } = await supabaseAdmin.from("simulated_charges").upsert({
    reference,
    amount,
    currency: intent.currency,
    status: "success",
    paid_at: new Date().toISOString(),
  });
  if (chargeErr) throw new Error(chargeErr.message);

  const secret = process.env.SIMULATED_GATEWAY_SECRET ?? "dev-simulated-secret";
  const body = JSON.stringify({
    event: "charge.success",
    event_id: `SIM-${reference}`,
    reference,
    // Deliberately wrong. If this figure ever reaches the ledger, the design
    // has failed and the verification suite will say so.
    amount: 999_999_999,
  });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  const res = await fetch(`${origin}/api/webhooks/payments/simulated`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-simulated-signature": signature },
    body,
  });
  if (!res.ok) {
    throw new Error(`The payment notification was rejected (${res.status}).`);
  }

  return {
    message: `₦${amount.toLocaleString("en-NG")} sent for confirmation.`,
    returnTo: `/dashboard/ledger/collections?ref=${encodeURIComponent(reference)}`,
  };
}
