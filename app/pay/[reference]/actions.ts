"use server";

import crypto from "node:crypto";
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { gatewayConfigured, isProduction } from "@/lib/gateway";
import { ok, fail, type ActionResult } from "@/lib/action-result";

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
): Promise<ActionResult<{ message: string; returnTo: string }>> {
  // Returned, not thrown, for the same reason as every other action: Next masks
  // thrown Server Action messages on ANY deployment, and `isProduction()` only
  // recognises VERCEL_ENV=production — so on a preview deployment this page
  // would show the generic "an error occurred" wall instead of the reason.
  if (isProduction()) return fail("This page is not available here.");

  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, amount_expected, currency, gateway, ledger_entry_id")
    .eq("gateway_reference", reference)
    .maybeSingle();

  if (!intent) return fail("That payment reference is not recognised.");
  if (intent.gateway !== "simulated" || gatewayConfigured(intent.currency)) {
    return fail("This payment must be made through the live gateway.");
  }
  if (intent.ledger_entry_id) {
    return ok({
      message: "Already received.",
      returnTo: `/dashboard/ledger/collections?ref=${reference}`,
    });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail("Enter an amount greater than zero.");
  }

  // The gateway's record. Verification reads this, not the message below.
  const { error: chargeErr } = await supabaseAdmin.from("simulated_charges").upsert({
    reference,
    amount,
    currency: intent.currency,
    status: "success",
    paid_at: new Date().toISOString(),
  });
  if (chargeErr) return fail(`The charge could not be recorded: ${chargeErr.message}`);

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
    return fail(`The payment notification was rejected (${res.status}).`);
  }

  return ok({
    message: `₦${amount.toLocaleString("en-NG")} sent for confirmation.`,
    returnTo: `/dashboard/ledger/collections?ref=${encodeURIComponent(reference)}`,
  });
}
