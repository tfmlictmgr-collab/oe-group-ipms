"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getGateway, gatewayConfigured } from "@/lib/gateway";
import { unusableForCheckout } from "@/lib/email-address";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Opens a checkout for the caller's OWN rent demand.
 *
 * ⚠️ Standing is decided in the database, not here. `create_rent_payment_intent`
 * checks that the caller is the lease's tenant (or staff scoped to it) — see
 * 0110, which added that check after finding the function had only ever
 * verified the ORGANISATION. This action deliberately does not re-implement
 * that test: one place decides who may pay a demand, and it is the one the
 * scheduled job and any future admin screen also go through.
 *
 * The amount is likewise never passed in. The RPC computes the outstanding
 * balance from the demand itself, so a tampered request cannot change what is
 * charged — the same rule `raisePaymentRequest` follows for service charges.
 */
export async function payMyRent(
  rentChargeId: string
): Promise<ActionResult<{ reference: string; checkoutUrl: string | null; simulated: boolean }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  // What the tenant can see of their own demand — via the definer-scoped
  // function, because a tenant has no read on properties/units.
  const { data: rows } = await supabase.rpc("my_rent_charges");
  const charge = (rows ?? []).find(
    (r: { charge_id: string }) => r.charge_id === rentChargeId
  ) as
    | { charge_id: string; outstanding: number | string; currency: string; open_intent_reference: string | null }
    | undefined;

  if (!charge) return fail("That rent demand could not be found.");

  // Already has a live link — hand back the existing one rather than asking
  // the RPC for a second and getting its (correct) refusal as an error. Two
  // checkout links for one debt is how a tenant pays twice.
  if (charge.open_intent_reference) {
    const { data: existing } = await supabase
      .from("payment_intents")
      .select("gateway_reference, checkout_url")
      .eq("gateway_reference", charge.open_intent_reference)
      .maybeSingle();
    if (existing) {
      return ok({
        reference: existing.gateway_reference,
        checkoutUrl: existing.checkout_url,
        simulated: !gatewayConfigured(charge.currency),
      });
    }
  }

  const outstanding = Number(charge.outstanding);
  if (!Number.isFinite(outstanding) || outstanding <= 0) {
    return fail("That rent is already paid in full.");
  }

  const receiptEmail = user.email ?? "";
  const emailProblem = unusableForCheckout(receiptEmail);
  if (emailProblem) {
    return fail(
      `Your email address cannot be used for checkout: ${emailProblem}`,
      "Ask your property manager to correct the email address on your account — the gateway needs a deliverable address to send your receipt."
    );
  }

  // The intent first, so the one-live-intent guard and the standing check both
  // run BEFORE a gateway session is opened. Raising a checkout for a payment
  // the database would refuse leaves a live link nothing can settle.
  const gateway = getGateway(charge.currency);
  const { data: intentId, error: rpcError } = await supabase.rpc("create_rent_payment_intent", {
    p_rent_charge_id: rentChargeId,
    p_gateway: gateway.name,
  });
  if (rpcError) {
    return fail(rpcError.message.replace(/^.*?:\s*/, ""));
  }

  const { data: intent } = await supabase
    .from("payment_intents")
    .select("gateway_reference, amount_expected, currency")
    .eq("id", intentId)
    .single();
  if (!intent) return fail("The payment could not be opened. Please try again.");

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

  const init = await gateway.initialise({
    reference: intent.gateway_reference,
    amount: Number(intent.amount_expected),
    currency: intent.currency,
    email: receiptEmail,
    callbackUrl: `${origin}/dashboard/my-rent?ref=${encodeURIComponent(intent.gateway_reference)}`,
    metadata: { purpose: "rent" },
  });

  if (!init.ok) {
    return fail(`The payment gateway rejected the request: ${init.error}`);
  }

  if (init.checkoutUrl) {
    await supabase
      .from("payment_intents")
      .update({ checkout_url: init.checkoutUrl })
      .eq("id", intentId);
  }

  revalidatePath("/dashboard/my-rent");
  return ok({
    reference: intent.gateway_reference,
    checkoutUrl: init.checkoutUrl ?? null,
    simulated: !gatewayConfigured(intent.currency),
  });
}
