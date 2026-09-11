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

  // ⚠️ The management fee is written to `orgs`, not here.
  //
  // Two screens used to own this number — Payment Gate wrote
  // `payment_settings.management_fee_percent`, Lettings wrote
  // `orgs.management_fee_pct` (decision 14). An administrator could set 10% on
  // one and 7% on the other and be right both times, and whichever path a
  // given piece of rent took would decide what the landlord was paid.
  //
  // `orgs` is the board's model and what every rent demand snapshots from, so
  // it is the source. `0095`'s trigger mirrors it back into `payment_settings`
  // for `create_landlord_remittance`, which still reads the old column.
  const { error: feeErr } = await supabase
    .from("orgs")
    .update({ management_fee_pct: managementFeePercent })
    .eq("id", orgId);
  if (feeErr) return failFromDb(feeErr, "save the management fee");

  // The admin fee percentage stays here: it has no equivalent on `orgs`, whose
  // `admin_fee_flat` is a deliberately different shape (decision 14 leaves the
  // admin fee's model open). Merging them would mean choosing that shape by
  // accident.
  const { error } = await supabase
    .from("payment_settings")
    .update({
      admin_fee_percent: adminFeePercent,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId);
  if (error) return failFromDb(error, "save these fees");

  revalidatePath("/dashboard/settings/payments");
  revalidatePath("/dashboard/settings/lettings");
  return ok();
}
