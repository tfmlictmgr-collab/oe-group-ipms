"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Leases and rent.
//
// Every write runs under the caller's own session, so `leases.write` and the
// property scoping decide what is permitted. Rent is raised exclusively through
// `raise_rent_charge`, which freezes the fee split onto the charge — this layer
// never computes a fee, because a fee computed in two places eventually
// disagrees with itself.

export type LeaseInput = {
  propertyId: string;
  unitId: string;
  tenantUserId: string | null;
  startDate: string;
  endDate: string;
  rentAmount: string;
  rentFrequency: "annual" | "quarterly" | "monthly";
  escalationPct: string;
  /** "" follows the organisation default; a value departs from it (0181). */
  adminFeeBasis: "" | "per_tenancy" | "per_demand";
  depositAmount: string;
  notes: string;
};

export async function createLease(input: LeaseInput): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const rent = Number(input.rentAmount.replace(/[,\s₦]/g, ""));
  if (!Number.isFinite(rent) || rent <= 0) return fail("Give the rent as a number greater than zero.");

  const escalation = Number(input.escalationPct.replace(/[%\s]/g, "") || "0");
  if (!Number.isFinite(escalation) || escalation < 0 || escalation > 100) {
    return fail("The escalation must be between 0 and 100 percent.");
  }

  const deposit = Number(input.depositAmount.replace(/[,\s₦]/g, "") || "0");
  if (!Number.isFinite(deposit) || deposit < 0) return fail("The deposit cannot be negative.");

  if (new Date(input.endDate) <= new Date(input.startDate)) {
    return fail("The tenancy has to end after it starts.");
  }

  // Refused rather than coerced: an unrecognised value means the form and the
  // enum have drifted, and silently falling back to the org default would be a
  // fee decision made by a typo.
  if (!["", "per_tenancy", "per_demand"].includes(input.adminFeeBasis)) {
    return fail("That is not a valid admin-fee basis for this tenancy.");
  }

  const { data, error } = await supabase.from("leases").insert({
    org_id: me.org_id,
    property_id: input.propertyId,
    unit_id: input.unitId,
    tenant_user_id: input.tenantUserId || null,
    start_date: input.startDate,
    end_date: input.endDate,
    rent_amount: rent,
    rent_frequency: input.rentFrequency,
    escalation_pct: escalation,
    admin_fee_basis: input.adminFeeBasis || null,
    deposit_amount: deposit,
    notes: input.notes.trim() || null,
    created_by: user.id,
  }).select("id").single();

  if (error) {
    // The exclusion constraint speaks in Postgres; a letting agent needs the
    // fact, which is that the flat is already taken for those dates.
    // 0328: the unit is allocated to somebody else. The database's sentence
    // already says what to do; it is passed through rather than retold.
    if (error.message.includes("allocated to someone else")) {
      return fail(error.message.replace(/^.*?:\s*/, ""));
    }
    if (error.message.includes("leases_no_overlap")) {
      return fail(
        "That unit is already let over those dates.",
        "End or terminate the existing tenancy first — a unit cannot be let twice for the same days."
      );
    }
    return failFromDb(error, "create this lease");
  }

  revalidatePath("/dashboard/leases");
  return ok({ id: data.id as string });
}

export async function activateLease(leaseId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_lease", { p_lease_id: leaseId });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/leases");
  return ok();
}

export async function renewLease(
  leaseId: string,
  months: number
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("renew_lease", {
    p_lease_id: leaseId,
    p_months: months,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/leases");
  return ok({ id: data as string });
}

/**
 * Bills a period of rent.
 *
 * The fee split is computed by the database, not here — `raise_rent_charge`
 * snapshots whichever rate applies onto the charge, so a later change to the
 * org default or a landlord's negotiated rate cannot rewrite what this demand
 * said (decision 14).
 */
export async function billRent(
  leaseId: string,
  periodStart: string,
  periodEnd: string,
  dueDate: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("raise_rent_charge", {
    p_lease_id: leaseId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_due_date: dueDate || null,
  });
  if (error) {
    if (error.message.includes("rent_charges_one_per_period")) {
      return fail("That period has already been billed on this lease.");
    }
    return fail(error.message.replace(/^.*?:\s*/, ""));
  }
  revalidatePath("/dashboard/leases");
  return ok();
}

/**
 * Ends a live tenancy and hands the unit back to the vacancy count.
 *
 * The act `createLease`'s own error copy has been telling letting agents to
 * perform since 0090 — "End or terminate the existing tenancy first" — while no
 * function in the schema set a lease to `expired` or `terminated` and nothing
 * anywhere cleared `occupant_user_id`. Vacancy could only ever fall.
 *
 * Whether this reads as an expiry or a termination is decided by the database
 * from the lease's own end date, not offered as a choice here: the two words
 * mean different things to a landlord, and a dropdown is how a renewal history
 * becomes a string of evictions.
 */
export async function endTenancy(
  leaseId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("end_tenancy", {
    p_lease_id: leaseId,
    p_reason: reason.trim() || null,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/leases");
  revalidatePath("/dashboard/properties");
  return ok();
}

export type LettableUnit = {
  id: string;
  label: string;
  /** The person allocated to the unit, if any. A tenancy here is for them. */
  occupantUserId: string | null;
  occupantName: string | null;
};

/**
 * Units a tenancy can be recorded on (0328): no live tenancy covering today.
 *
 * ⚠️ This used to be `vacant_units_for_property`, and vacancy is "no occupant
 * AND no live tenancy" (0200). A tenant who arrived by invitation is the unit's
 * occupant with no lease at all, so their own unit was missing from the one
 * form that records their tenancy. Vacancy is still that rule for the
 * counters and the intake window; this asks a different question, and the
 * occupant comes back with the unit so the form can say who the tenancy is
 * for. `leases_for_the_units_occupant` refuses a tenancy for anyone else.
 */
export async function lettableUnitsFor(
  propertyId: string
): Promise<ActionResult<{ units: LettableUnit[] }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("lettable_units_for_property", {
    p_property_id: propertyId,
  });
  if (error) return failFromDb(error, "read this property's units");

  // `display_label` carries the distinguisher — since 0198 the label alone is a
  // TYPE, so twelve stalls would otherwise be twelve identical dropdown entries.
  return ok({
    units: (data ?? []).map((u: {
      id: string; display_label: string; occupant_user_id: string | null; occupant_name: string | null;
    }) => ({
      id: u.id,
      label: u.display_label,
      occupantUserId: u.occupant_user_id,
      occupantName: u.occupant_name,
    })),
  });
}

/**
 * Records who the tenant of a tenancy IS, where nobody with a portal account
 * holds it (decision 37's `tenant_name` / `tenant_phone`).
 *
 * ⚠️ Found building People → Directory (11 Sept 2026): four live OEA tenancies
 * named nobody at all — no account and no tenant of record — and there was no
 * control anywhere to say who lived there. The import writes these columns and
 * nothing else ever could, so a tenancy created by hand before decision 37 was
 * permanently anonymous on the one report whose job is to say who is in which
 * unit.
 *
 * Runs in the caller's session: `leases_write` decides (the letting
 * permission, bounded to properties they hold), and `audit_leases` records the
 * change. A tenancy held by a portal account is refused, because that tenant is
 * named by their own account and a second name beside it would be two answers
 * to one question — `tenancy_schedule` coalesces the account first for exactly
 * that reason.
 */
export async function recordTenantOfRecord(
  leaseId: string,
  input: { name: string; phone: string }
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const name = input.name.trim().replace(/\s+/g, " ");
  const phone = input.phone.trim();
  if (name.length < 2 || name.length > 160) {
    return fail("Give the tenant's name — a person or a company, as it appears on the tenancy.");
  }
  if (phone && !/^\+?[\d\s()-]{7,20}$/.test(phone)) {
    return fail("That phone number does not look right.", "Digits, spaces and a leading + only.");
  }

  const { data: lease } = await supabase
    .from("leases").select("id, tenant_user_id").eq("id", leaseId).maybeSingle();
  if (!lease) return fail("That tenancy was not found.");
  if (lease.tenant_user_id) {
    return fail(
      "This tenancy is held by a portal account, and that account names the tenant.",
      "Change the name on their profile instead."
    );
  }

  // `.select()` because an UPDATE that RLS declines matches nothing and raises
  // nothing — decision 38. Zero rows back is a refusal, and is reported as one.
  const { data: updated, error } = await supabase
    .from("leases")
    .update({ tenant_name: name, tenant_phone: phone || null })
    .eq("id", leaseId)
    .is("tenant_user_id", null)
    .select("id");
  if (error) return failFromDb(error, "record the tenant");
  if (!updated || updated.length === 0) {
    return fail(
      "You cannot change this tenancy.",
      "Recording a tenant needs the letting permission on this property."
    );
  }

  revalidatePath(`/dashboard/leases/${leaseId}`);
  revalidatePath("/dashboard/schedule");
  revalidatePath("/dashboard/people/directory");
  return ok();
}

/**
 * Corrects a tenancy's terms entered by mistake (0329). A draft is edited
 * freely; a live tenancy needs a reason, which `correct_lease_terms` writes to
 * the audit trail with the before and after. Demands already raised keep their
 * own figures — a wrong demand is corrected on its own, below.
 */
export async function correctLeaseTerms(
  leaseId: string,
  input: {
    rentAmount: string;
    rentFrequency: "annual" | "quarterly" | "monthly";
    depositAmount: string;
    escalationPct: string;
    startDate: string;
    endDate: string;
    reason: string;
  }
): Promise<ActionResult> {
  const rent = Number(input.rentAmount.replace(/[,\s₦$£€]/g, ""));
  const deposit = Number(input.depositAmount.replace(/[,\s₦$£€]/g, "") || "0");
  const escalation = Number(input.escalationPct.replace(/[%\s]/g, "") || "0");
  if (!Number.isFinite(rent) || !Number.isFinite(deposit) || !Number.isFinite(escalation)) {
    return fail("Give the rent, deposit and escalation as numbers.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_lease_terms", {
    p_lease_id: leaseId,
    p_rent_amount: rent,
    p_rent_frequency: input.rentFrequency,
    p_deposit_amount: deposit,
    p_escalation_pct: escalation,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_reason: input.reason.trim() || null,
  });
  if (error) {
    if (error.message.includes("leases_no_overlap")) {
      return fail(
        "Those dates overlap another live tenancy on this unit.",
        "A unit cannot be let twice for the same days."
      );
    }
    return fail(error.message);
  }
  revalidatePath(`/dashboard/leases/${leaseId}`);
  revalidatePath("/dashboard/leases");
  revalidatePath("/dashboard/schedule");
  return ok();
}

/**
 * Corrects a rent demand raised at the wrong amount or for the wrong period
 * (0329) — only while nothing has happened to it. The fee is recomputed by the
 * database at the rate already frozen on the demand (decision 14).
 */
export async function correctRentCharge(
  leaseId: string,
  chargeId: string,
  input: { amount: string; periodStart: string; periodEnd: string; dueDate: string; reason: string }
): Promise<ActionResult> {
  const amount = Number(input.amount.replace(/[,\s₦$£€]/g, ""));
  if (!Number.isFinite(amount)) return fail("Give the amount as a number.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_rent_charge", {
    p_charge_id: chargeId,
    p_amount: amount,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_due_date: input.dueDate || null,
    p_reason: input.reason.trim(),
  });
  if (error) {
    if (error.message.includes("rent_charges_one_per_period")) {
      return fail("That period has already been billed on this tenancy.");
    }
    return fail(error.message);
  }
  revalidatePath(`/dashboard/leases/${leaseId}`);
  revalidatePath("/dashboard/leases");
  return ok();
}
