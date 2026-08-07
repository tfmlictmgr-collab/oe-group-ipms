"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getGateway, gatewayConfigured } from "@/lib/gateway";
import { unusableForCheckout } from "@/lib/email-address";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Opens a checkout for the caller's OWN service-charge invoice.
 *
 * Deliberately the same shape as `payMyRent` — same order of operations, same
 * refusals, same reason for each — because they are the same transaction
 * against a different debt, and two collection paths that drift apart is how
 * one of them ends up without a guard the other has.
 *
 * ⚠️ Standing is decided in the database (`create_service_charge_payment_intent`,
 * 0123), not here: the caller must be the person billed, an oversight role, or
 * an FM/PM scoped to the property. This action does not re-implement that test.
 *
 * The amount is likewise never passed in. The RPC computes `amount -
 * amount_paid` from the invoice itself, so a tampered request cannot change
 * what is charged.
 */
export async function payMyServiceCharge(
  serviceChargeId: string
): Promise<ActionResult<{ reference: string; checkoutUrl: string | null; simulated: boolean }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: rows } = await supabase.rpc("my_service_charges");
  const charge = (rows ?? []).find(
    (r: { charge_id: string }) => r.charge_id === serviceChargeId
  ) as
    | { charge_id: string; outstanding: number | string; open_intent_reference: string | null }
    | undefined;

  if (!charge) return fail("That invoice could not be found.");

  // Already has a live link — hand back the existing one rather than asking the
  // RPC for a second and getting its (correct) refusal as an error. Two
  // checkout links for one debt is how a payer pays twice.
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
        simulated: !gatewayConfigured("NGN"),
      });
    }
  }

  const outstanding = Number(charge.outstanding);
  if (!Number.isFinite(outstanding) || outstanding <= 0) {
    return fail("That invoice is already paid in full.");
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
  const gateway = getGateway("NGN");
  const { data: intentId, error: rpcError } = await supabase.rpc(
    "create_service_charge_payment_intent",
    { p_service_charge_id: serviceChargeId, p_gateway: gateway.name }
  );
  if (rpcError) return fail(rpcError.message.replace(/^.*?:\s*/, ""));

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
    callbackUrl: `${origin}/dashboard/statements?ref=${encodeURIComponent(intent.gateway_reference)}`,
    metadata: { purpose: "service_charge" },
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

  revalidatePath("/dashboard/statements");
  return ok({
    reference: intent.gateway_reference,
    checkoutUrl: init.checkoutUrl ?? null,
    simulated: !gatewayConfigured(intent.currency),
  });
}
