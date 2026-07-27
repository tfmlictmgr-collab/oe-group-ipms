"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getGateway, gatewayConfigured, newPaymentReference } from "@/lib/gateway";
import { unusableForCheckout } from "@/lib/email-address";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Raising a request for payment. Staff-only by RLS; this layer additionally
// fixes the AMOUNT server-side from our own record before the gateway is ever
// contacted, so the figure a payer sees cannot be influenced by anything they
// send.
//
// Expected failures are RETURNED, not thrown. Next.js replaces the message of
// any error thrown in a Server Action with an opaque digest in production
// builds — correctly, since a thrown error may carry internals. The effect is
// that every message written here ("that invoice is already paid", "the gateway
// rejected the email") reaches the user as "an error occurred" and nothing
// else. A finance user then has a broken button and no idea why. So anything a
// user can act on is part of the return type; only genuinely unexpected faults
// are left to throw.

export type RaiseInput = {
  purpose: "service_charge" | "rent" | "deposit" | "other";
  serviceChargeId?: string | null;
  payerUserId?: string | null;
  /** Only used when there is no source record to read the amount from. */
  amount?: number;
  currency?: string;
  email?: string;
};

export type RaiseResult = ActionResult<{
  reference: string;
  checkoutUrl: string | null;
  simulated: boolean;
}>;

export async function raisePaymentRequest(input: RaiseInput): Promise<RaiseResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id, role, email").eq("id", user.id).single();
  // Deliberately narrower than the INSERT policy, which also admits an FM.
  // The duplicate-request check below reads payment_intents, and only finance
  // and admin can SELECT them — an FM would pass the check blindly and could
  // raise a second checkout link for an invoice that already has one.
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return fail("Only finance or an administrator can request a payment.");
  }

  const currency = (input.currency ?? "NGN").toUpperCase();

  // The amount comes from the invoice we issued, never from the caller, so a
  // tampered request cannot change what is charged.
  let amount = Number(input.amount ?? 0);
  let payer = input.payerUserId ?? null;
  let propertyId: string | null = null;
  let unitId: string | null = null;

  if (input.serviceChargeId) {
    const { data: sc } = await supabase
      .from("service_charges")
      .select("id, amount, status, billed_to_user_id, unit_id, org_id")
      .eq("id", input.serviceChargeId)
      .single();
    if (!sc) return fail("That service charge could not be found.");
    if (sc.status === "paid") return fail("That service charge is already paid.");

    amount = Number(sc.amount);
    payer = payer ?? sc.billed_to_user_id;
    unitId = sc.unit_id;

    if (unitId) {
      const { data: unit } = await supabase
        .from("units").select("property_id").eq("id", unitId).single();
      propertyId = unit?.property_id ?? null;
    }

    // One live request per invoice — two checkout links for the same charge
    // invites paying twice.
    const { data: existing } = await supabase
      .from("payment_intents")
      .select("id, gateway_reference, checkout_url, status")
      .eq("service_charge_id", sc.id)
      .in("status", ["pending", "part_paid"])
      .maybeSingle();
    if (existing) {
      return ok({
        reference: existing.gateway_reference,
        checkoutUrl: existing.checkout_url,
        simulated: !gatewayConfigured(currency),
      });
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return fail("There is nothing to collect on that record.");
  }

  // Look up the payer's email for the gateway receipt; fall back to the
  // requester's so a checkout can still be raised for an unassigned unit.
  let email: string | null = input.email ?? null;
  if (!email && payer) {
    const { data: p } = await supabase.from("users").select("email").eq("id", payer).single();
    email = (p?.email as string | null) ?? null;
  }
  const receiptEmail: string = email ?? (me.email as string | null) ?? "";

  // Checked here rather than discovered as a gateway error, because the fix is
  // an administrative one — edit the person's email — and the message should
  // say so plainly.
  const emailProblem = unusableForCheckout(receiptEmail);
  if (emailProblem) {
    return fail(
      `The payer's email address cannot be used for checkout: ${emailProblem}`,
      `Update ${receiptEmail || "the payer's record"} under People to a real, deliverable address. Payment gateways refuse reserved domains, and the payer needs a working address to receive the receipt.`
    );
  }

  const reference = newPaymentReference(input.purpose);
  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

  const gateway = getGateway(currency);
  const init = await gateway.initialise({
    reference,
    amount,
    currency,
    email: receiptEmail,
    callbackUrl: `${origin}/dashboard/ledger/collections?ref=${encodeURIComponent(reference)}`,
    metadata: { org_id: me.org_id, purpose: input.purpose },
  });

  if (!init.ok) {
    return fail(
      `${gateway.name === "paystack" ? "Paystack" : gateway.name} rejected the request: ${init.error}`
    );
  }

  const { error } = await supabase.from("payment_intents").insert({
    org_id: me.org_id,
    purpose: input.purpose,
    service_charge_id: input.serviceChargeId ?? null,
    property_id: propertyId,
    unit_id: unitId,
    payer_user_id: payer,
    amount_expected: amount,
    currency,
    gateway: gateway.name,
    gateway_reference: reference,
    checkout_url: init.checkoutUrl ?? null,
    created_by: user.id,
  });
  if (error) return failFromDb(error, "save this payment request");

  revalidatePath("/dashboard/ledger/collections");
  return ok({
    reference,
    checkoutUrl: init.checkoutUrl ?? null,
    simulated: gateway.name === "simulated",
  });
}

export type RefreshResult = ActionResult<{ status: string; posted: boolean }>;

/**
 * Re-checks a payment with the gateway and posts it if it succeeded.
 *
 * The webhook is the primary path; this exists because webhooks can be delayed
 * or lost, and a payer who has been charged should not have to wait. It uses the
 * same server-to-server verification and the same idempotent posting, so calling
 * it after the webhook has already run is harmless.
 */
export async function refreshPaymentStatus(intentId: string): Promise<RefreshResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return fail("Only finance or an administrator can reconcile a payment.");
  }

  const { data: intent } = await supabase
    .from("payment_intents")
    .select("id, gateway, gateway_reference, currency, amount_expected, ledger_entry_id, status")
    .eq("id", intentId)
    .single();
  if (!intent) return fail("Payment request not found.");
  if (intent.ledger_entry_id) return ok({ status: intent.status, posted: true });

  const gateway = getGateway(intent.currency);
  const verified = await gateway.verifyTransaction(intent.gateway_reference);

  if (!verified.ok || verified.status !== "success") {
    return ok({ status: verified.status ?? "pending", posted: false });
  }

  // Posting needs the service role: record_collection is deliberately not
  // granted to `authenticated`, so a signed-in user cannot post a collection
  // without going through this verification first.
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { error } = await supabaseAdmin.rpc("record_collection", {
    p_intent_id: intent.id,
    p_amount_verified: verified.amount ?? Number(intent.amount_expected),
    p_paid_at: verified.paidAt ?? new Date().toISOString(),
  });
  if (error) return fail(`The payment could not be posted: ${error.message}`);

  revalidatePath("/dashboard/ledger/collections");
  revalidatePath("/dashboard/ledger");
  return ok({ status: "paid", posted: true });
}
