"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

/**
 * Fees the organisation retains from rent before remitting to the landlord
 * (CLAUDE.md OEA decision #1). Bounded server-side as well as in the form: a
 * fee over 100% would mean the landlord receives nothing, and a negative one
 * would mean paying them more than was collected.
 */
export async function updateFeeSettings(
  orgId: string,
  managementFeePercent: number,
  adminFeePercent: number
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin" || me.org_id !== orgId) {
    return fail("Only an administrator of this organisation can change fees.");
  }

  for (const [label, v] of [
    ["Management fee", managementFeePercent],
    ["Admin fee", adminFeePercent],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return fail(`${label} must be between 0 and 100.`);
    }
  }
  if (managementFeePercent + adminFeePercent > 100) {
    return fail(
      "Fees cannot total more than 100%.",
      "At 100% the landlord receives nothing — check the two percentages."
    );
  }

  const { error } = await supabase
    .from("payment_settings")
    .update({
      management_fee_percent: managementFeePercent,
      admin_fee_percent: adminFeePercent,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId);
  if (error) return failFromDb(error, "save these fees");

  revalidatePath("/dashboard/settings/payments");
  return ok();
}
