"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { unusableForCheckout } from "@/lib/email-address";
import { fail, type ActionResult } from "@/lib/action-result";
import { openCheckout, checkReturnedPayment, type CheckoutResult } from "@/lib/gateway/checkout";

/**
 * Opens — or continues — a checkout for the caller's OWN service-charge invoice.
 *
 * The same transaction as `payMyRent` against a different debt, and now the
 * same CODE (`openCheckout`): the two were copies, and both carried the same
 * three faults at once (0288) — the platform merchant account, a checkout
 * address that was never saved, and an open payment that was re-opened rather
 * than checked.
 *
 * ⚠️ Standing is decided in the database (`create_service_charge_payment_intent`,
 * 0123), not here: the caller must be the person billed, an oversight role, or
 * an FM/PM scoped to the property. The amount is never passed in.
 */
export async function payMyServiceCharge(
  serviceChargeId: string
): Promise<ActionResult<CheckoutResult>> {
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

  if (!charge.open_intent_reference) {
    const outstanding = Number(charge.outstanding);
    if (!Number.isFinite(outstanding) || outstanding <= 0) {
      return fail("That invoice is already paid in full.");
    }
  }

  const receiptEmail = user.email ?? "";
  const emailProblem = unusableForCheckout(receiptEmail);
  if (emailProblem) {
    return fail(
      `Your email address cannot be used for checkout: ${emailProblem}`,
      "Ask your property manager to correct the email address on your account — the gateway needs a deliverable address to send your receipt."
    );
  }

  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your account.");

  const result = await openCheckout({
    supabase,
    userEmail: receiptEmail,
    orgId: me.org_id,
    // Service charge is Naira by design (decision 15; 0284 refuses FX lines).
    currency: "NGN",
    openReference: charge.open_intent_reference,
    createIntent: (gateway) =>
      supabase.rpc("create_service_charge_payment_intent", {
        p_service_charge_id: serviceChargeId,
        p_gateway: gateway,
      }),
    returnPath: "/dashboard/statements",
    purpose: "service_charge",
  });
  revalidatePath("/dashboard/statements");
  return result;
}

/** The return from checkout: asks the gateway, server-to-server, whether it was paid. */
export async function checkMyServiceChargePayment(reference: string) {
  const supabase = await createClient();
  const r = await checkReturnedPayment(supabase, reference);
  revalidatePath("/dashboard/statements");
  return r;
}
