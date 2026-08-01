"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

/**
 * The lettings settings an administrator owns: the default management fee, the
 * flat admin fee, when renewal notices go out, and how far ahead rent is
 * demanded.
 *
 * ⚠️ The fee written here is the org DEFAULT (decision 14). It affects demands
 * raised from now on and nothing already issued — every `rent_charge` froze its
 * own rate when it was raised, which is the whole point of the decision. The UI
 * says so, because "changing the fee" sounds retrospective and is not.
 */
export async function saveLettingsSettings(input: {
  managementFeePct: string;
  adminFeeFlat: string;
  renewalNoticeDays: string;
  rentDemandLeadDays: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id, role").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");
  if (me.role !== "admin") {
    return fail("Only an administrator can change lettings settings.");
  }

  const fee = Number(input.managementFeePct.replace(/[%\s]/g, ""));
  if (!Number.isFinite(fee) || fee < 0 || fee > 100) {
    return fail("The management fee must be between 0 and 100 percent.");
  }

  const adminFee = Number(input.adminFeeFlat.replace(/[,\s₦]/g, "") || "0");
  if (!Number.isFinite(adminFee) || adminFee < 0) {
    return fail("The admin fee cannot be negative.");
  }

  // "90, 60, 30" — parsed permissively because someone will type it with
  // spaces, and refused only when it cannot mean anything.
  const days = input.renewalNoticeDays
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map(Number);

  if (days.length === 0) {
    return fail("Give at least one notice period, e.g. 90, 60, 30.");
  }
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 3650)) {
    return fail("Each notice period must be a whole number of days between 1 and 3650.");
  }
  // Duplicates would make the same notice fire twice at the same threshold —
  // the unique key on lease_notices would then silently swallow the second,
  // which looks like a lost notice rather than a rejected setting.
  if (new Set(days).size !== days.length) {
    return fail("Each notice period must be different.");
  }

  const lead = Number(input.rentDemandLeadDays.replace(/\s/g, "") || "0");
  if (!Number.isInteger(lead) || lead < 0 || lead > 365) {
    return fail("The rent demand lead must be a whole number of days between 0 and 365.");
  }

  const { error } = await supabase
    .from("orgs")
    .update({
      management_fee_pct: fee,
      admin_fee_flat: adminFee,
      renewal_notice_days: days.sort((a, b) => b - a),
      rent_demand_lead_days: lead,
    })
    .eq("id", me.org_id);

  if (error) return failFromDb(error, "save these settings");

  revalidatePath("/dashboard/settings/lettings");
  revalidatePath("/dashboard/leases");
  return ok();
}

/** A landlord's negotiated rate, or clearing it back to the org default. */
export async function setLandlordFee(
  landlordUserId: string,
  pct: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  let value: number | null = null;
  if (pct !== null && pct.trim() !== "") {
    value = Number(pct.replace(/[%\s]/g, ""));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return fail("A negotiated rate must be between 0 and 100 percent.");
    }
  }

  // Upsert: a landlord has at most one set of terms, and clearing the rate
  // leaves the row so the fact that terms were once negotiated is not lost.
  const { error } = await supabase
    .from("landlord_terms")
    .upsert(
      { org_id: me.org_id, landlord_user_id: landlordUserId, management_fee_pct: value, agreed_by: user.id },
      { onConflict: "org_id,landlord_user_id" }
    );

  if (error) return failFromDb(error, "save that rate");
  revalidatePath("/dashboard/settings/lettings");
  return ok();
}
