"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { apportion } from "@/lib/apportionment";

// Generates (or regenerates) per-unit service-charge invoices for a budget by
// apportioning its total across the property's units. Runs under the caller's
// session, so RLS enforces that only admin/finance can do this.
export async function generateInvoices(budgetId: string) {
  const supabase = await createClient();

  const { data: budget, error: bErr } = await supabase
    .from("sc_budgets")
    .select("id, org_id, property_id, period, total_amount")
    .eq("id", budgetId)
    .single();
  if (bErr || !budget) throw new Error(bErr?.message ?? "Budget not found");

  const { data: property } = await supabase
    .from("properties")
    .select("name")
    .eq("id", budget.property_id)
    .single();

  const { data: units, error: uErr } = await supabase
    .from("units")
    .select("id, label, apportionment_factor, occupant_user_id")
    .eq("property_id", budget.property_id);
  if (uErr) throw new Error(uErr.message);
  if (!units || units.length === 0) throw new Error("No units to apportion to");

  const shares = apportion(
    Number(budget.total_amount),
    units.map((u) => ({
      id: u.id,
      label: u.label,
      factor: Number(u.apportionment_factor),
      occupant_user_id: u.occupant_user_id,
    }))
  );

  // Regenerate cleanly: clear prior invoices for this budget first.
  await supabase.from("service_charges").delete().eq("budget_id", budgetId);

  const rows = shares.map((s) => ({
    org_id: budget.org_id,
    budget_id: budget.id,
    unit_id: s.id,
    billed_to_user_id: s.occupant_user_id ?? null,
    property_or_unit: `${property?.name ?? "Property"} · ${s.label}`,
    billing_period: budget.period,
    amount: s.amount,
    apportionment_pct: Number((s.pct * 100).toFixed(4)),
    status: "invoiced",
  }));

  const { error: insErr } = await supabase.from("service_charges").insert(rows);
  if (insErr) throw new Error(insErr.message);

  await supabase
    .from("sc_budgets")
    .update({ status: "invoiced" })
    .eq("id", budgetId);

  revalidatePath(`/dashboard/sc/${budgetId}`);
  revalidatePath("/dashboard/sc");
}
