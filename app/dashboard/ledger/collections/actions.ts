"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getGateway, gatewayConfigured, newPaymentReference } from "@/lib/gateway";

// Raising a request for payment. Staff-only by RLS; this layer additionally
// fixes the AMOUNT server-side from our own record before the gateway is ever
// contacted, so the figure a payer sees cannot be influenced by anything they
// send.

export type RaiseInput = {
  purpose: "service_charge" | "rent" | "deposit" | "other";
  serviceChargeId?: string | null;
  payerUserId?: string | null;
  /** Only used when there is no source record to read the amount from. */
  amount?: number;
  currency?: string;
  email?: string;
};

export async function raisePaymentRequest(input: RaiseInput): Promise<{
  reference: string;
  checkoutUrl: string | null;
  simulated: boolean;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role, email").eq("id", user.id).single();
  // Deliberately narrower than the INSERT policy, which also admits an FM.
  // The duplicate-request check below reads payment_intents, and only finance
  // and admin can SELECT them — an FM would pass the check blindly and could
  // raise a second checkout link for an invoice that already has one.
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    throw new Error("Only finance or an administrator can request a payment.");
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
    if (!sc) throw new Error("That service charge could not be found.");
    if (sc.status === "paid") throw new Error("That service charge is already paid.");

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
      return {
        reference: existing.gateway_reference,
        checkoutUrl: existing.checkout_url,
        simulated: !gatewayConfigured(currency),
      };
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("There is nothing to collect on that record.");
  }

  const reference = newPaymentReference(input.purpose);
  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

  // Look up the payer's email for the gateway receipt; fall back to the
  // requester's so a checkout can still be raised for an unassigned unit.
  let email: string | null = input.email ?? null;
  if (!email && payer) {
    const { data: p } = await supabase.from("users").select("email").eq("id", payer).single();
    email = (p?.email as string | null) ?? null;
  }
  const receiptEmail: string = email ?? (me.email as string | null) ?? "billing@oegroup.test";

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
    throw new Error(`The payment gateway rejected the request: ${init.error}`);
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
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/ledger/collections");
  return {
    reference,
    checkoutUrl: init.checkoutUrl ?? null,
    simulated: gateway.name === "simulated",
  };
}

/**
 * Re-checks a payment with the gateway and posts it if it succeeded.
 *
 * The webhook is the primary path; this exists because webhooks can be delayed
 * or lost, and a payer who has been charged should not have to wait. It uses the
 * same server-to-server verification and the same idempotent posting, so calling
 * it after the webhook has already run is harmless.
 */
export async function refreshPaymentStatus(intentId: string): Promise<{
  status: string;
  posted: boolean;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    throw new Error("Only finance or an administrator can reconcile a payment.");
  }

  const { data: intent } = await supabase
    .from("payment_intents")
    .select("id, gateway, gateway_reference, currency, amount_expected, ledger_entry_id, status")
    .eq("id", intentId)
    .single();
  if (!intent) throw new Error("Payment request not found.");
  if (intent.ledger_entry_id) return { status: intent.status, posted: true };

  const gateway = getGateway(intent.currency);
  const verified = await gateway.verifyTransaction(intent.gateway_reference);

  if (!verified.ok || verified.status !== "success") {
    return { status: verified.status ?? "pending", posted: false };
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
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/ledger/collections");
  revalidatePath("/dashboard/ledger");
  return { status: "paid", posted: true };
}
