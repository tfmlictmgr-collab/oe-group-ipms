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
    deposit_amount: deposit,
    notes: input.notes.trim() || null,
    created_by: user.id,
  }).select("id").single();

  if (error) {
    // The exclusion constraint speaks in Postgres; a letting agent needs the
    // fact, which is that the flat is already taken for those dates.
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

/** Units with no active tenancy on the given property — what can actually be let. */
export async function vacantUnitsFor(
  propertyId: string
): Promise<ActionResult<{ units: { id: string; label: string }[] }>> {
  const supabase = await createClient();
  const [unitsRes, leasesRes] = await Promise.all([
    supabase.from("units").select("id, label").eq("property_id", propertyId)
      .is("deleted_at", null).order("label"),
    supabase.from("leases").select("unit_id").eq("property_id", propertyId)
      .in("status", ["active", "renewed"]).is("deleted_at", null),
  ]);
  if (unitsRes.error) return failFromDb(unitsRes.error, "read this property's units");

  const taken = new Set((leasesRes.data ?? []).map((l) => l.unit_id));
  return ok({ units: (unitsRes.data ?? []).filter((u) => !taken.has(u.id)) });
}
