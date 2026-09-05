"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Creating a service-charge budget.
//
// ⚠️ This did not exist. `sc_budgets` has had an insert policy since 0055 and
// the list page has invited the reader to "create a budget for a property"
// since Day 9 — but nothing in the application ever inserted one, so every
// budget in the system arrived by hand in SQL. The module's whole entry point
// was missing while its exit (invoicing) was finished.
//
// Runs under the caller's own session, never the service role: `sc_budgets_insert`
// requires `has_permission('sc.manage')`, so the database decides. The page
// asks the same question first (0055's split write/read policies mean a refusal
// here would otherwise surface as an unexplained error rather than a hidden
// button), but the check on this side is the one that counts.

export type BudgetInput = {
  propertyId: string;
  period: string;
  description: string;
  totalAmount: number;
};

export async function createBudget(input: BudgetInput): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("You are not signed in.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const period = input.period.trim();
  const description = input.description.trim();

  if (!input.propertyId) return fail("Choose the property this budget belongs to.");
  if (!period) return fail("Give the budget a period, e.g. 2026.");

  // A budget of zero apportions to nothing, and a negative one would invoice
  // credits nobody asked for. Refuse both here as well as at the column level —
  // the message a person reads should say what to do about it.
  if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
    return fail(
      "The budget total has to be a positive amount.",
      "This is the sum apportioned across the property's units."
    );
  }

  // One budget per property per period. Caught here for a readable message; the
  // real guard is `sc_budgets_one_per_property_period_uidx` (0109), because a
  // second budget silently double-invoices every unit of the property.
  //
  // Compared the same way the index keys it — normalised, not raw — so this
  // check and the database agree on what "already exists" means. A property
  // carries a handful of budgets (one per period), so reading them to compare
  // in-process costs nothing and avoids escaping the caller's text into a
  // pattern match.
  const samePeriod = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

  const { data: existing } = await supabase
    .from("sc_budgets")
    .select("id, period")
    .eq("property_id", input.propertyId);
  if ((existing ?? []).some((b) => samePeriod(b.period as string, period))) {
    return fail(
      `That property already has a ${period} budget.`,
      "Open the existing one to amend it, or use a different period."
    );
  }

  const { data, error } = await supabase
    .from("sc_budgets")
    .insert({
      org_id: me.org_id,
      property_id: input.propertyId,
      period,
      description: description || null,
      total_amount: input.totalAmount,
      status: "draft",
    })
    .select("id")
    .single();

  // The race the check above cannot close: two submissions that both read
  // "no clash" and both insert. One of them now loses at the index (0109).
  // `failFromDb`'s generic duplicate-key wording ("that create this budget
  // already exists") would be the one place a user meets this, so it is
  // answered here with the same sentence the pre-check gives — losing the
  // race and being second should read identically, because they are the same
  // fact.
  if (error?.code === "23505") {
    return fail(
      `That property already has a ${period} budget.`,
      "Open the existing one to amend it, or use a different period."
    );
  }
  if (error) return failFromDb(error, "create this budget");

  revalidatePath("/dashboard/sc");
  return ok({ id: data.id as string });
}
