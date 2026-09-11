"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { unusableForCheckout } from "@/lib/email-address";
import { fail, type ActionResult } from "@/lib/action-result";
import { openCheckout, checkReturnedPayment, type CheckoutResult } from "@/lib/gateway/checkout";

/**
 * Opens — or continues — a checkout for the caller's OWN rent demand.
 *
 * ⚠️ Standing is decided in the database, not here. `create_rent_payment_intent`
 * checks that the caller is the lease's tenant (or staff scoped to it) — see
 * 0110, which added that check after finding the function had only ever
 * verified the ORGANISATION. The amount is likewise never passed in: the RPC
 * computes the outstanding balance from the demand itself.
 *
 * Which merchant account takes the money is decided by `openCheckout` →
 * `resolveOrgGateway` (0288): this organisation's own, or none.
 */
export async function payMyRent(rentChargeId: string): Promise<ActionResult<CheckoutResult>> {
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

  if (!charge.open_intent_reference) {
    const outstanding = Number(charge.outstanding);
    if (!Number.isFinite(outstanding) || outstanding <= 0) {
      return fail("That rent is already paid in full.");
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
    currency: charge.currency,
    openReference: charge.open_intent_reference,
    createIntent: (gateway) =>
      supabase.rpc("create_rent_payment_intent", { p_rent_charge_id: rentChargeId, p_gateway: gateway }),
    returnPath: "/dashboard/my-rent",
    purpose: "rent",
  });
  revalidatePath("/dashboard/my-rent");
  return result;
}

/** The return from checkout: asks the gateway, server-to-server, whether it was paid. */
export async function checkMyRentPayment(reference: string) {
  const supabase = await createClient();
  const r = await checkReturnedPayment(supabase, reference);
  revalidatePath("/dashboard/my-rent");
  return r;
}
