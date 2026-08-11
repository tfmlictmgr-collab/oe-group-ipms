"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { apportion } from "@/lib/apportionment";
import { sendCascade } from "@/lib/cascade";
import { formatNaira } from "@/lib/currency";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Generates (or regenerates) per-unit service-charge invoices for a budget by
// apportioning its total across the property's units. Runs under the caller's
// session, so RLS enforces that only admin/finance can do this.
export async function generateInvoices(budgetId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: budget, error: bErr } = await supabase
    .from("sc_budgets")
    .select("id, org_id, property_id, period, total_amount")
    .eq("id", budgetId)
    .single();
  if (bErr || !budget) return fail("That budget could not be found.");

  const { data: property } = await supabase
    .from("properties")
    .select("name")
    .eq("id", budget.property_id)
    .single();

  const { data: units, error: uErr } = await supabase
    .from("units")
    .select("id, label, apportionment_factor, occupant_user_id")
    .eq("property_id", budget.property_id);
  if (uErr) return failFromDb(uErr, "read the units for this property");
  if (!units || units.length === 0) {
    return fail(
      "This property has no units, so there is nothing to apportion the budget across.",
      "Add the units first, with their apportionment factors."
    );
  }

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
  //
  // The delete's error was previously discarded, and that was a double-billing
  // bug waiting to happen. `payment_intents.service_charge_id` has no ON DELETE
  // clause, so once a payment has been requested against any of these invoices
  // the delete FAILS — and the insert below would then have added a second
  // invoice for the same unit and period, alongside one that may already be
  // paid. A budget cannot be silently re-invoiced over live collections.
  const { error: delErr } = await supabase
    .from("service_charges")
    .delete()
    .eq("budget_id", budgetId);

  if (delErr) {
    if (/foreign key/i.test(delErr.message)) {
      return fail(
        "These invoices cannot be regenerated: a payment has already been requested against at least one of them.",
        "Regenerating would raise a second invoice for the same unit and period. Cancel the outstanding payment requests first, or issue an adjustment instead."
      );
    }
    return failFromDb(delErr, "clear the previous invoices");
  }

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
  if (insErr) return failFromDb(insErr, "generate these invoices");

  await supabase
    .from("sc_budgets")
    .update({ status: "invoiced" })
    .eq("id", budgetId);

  // Notify each occupant of their new statement via the B8 cascade (best-effort).
  try {
    const occupantIds = shares
      .map((s) => s.occupant_user_id)
      .filter((id): id is string => !!id);
    if (occupantIds.length > 0) {
      const { data: occupants } = await supabase
        .from("users")
        .select("id, email, phone")
        .in("id", occupantIds);
      for (const share of shares) {
        if (!share.occupant_user_id) continue;
        const u = occupants?.find((o) => o.id === share.occupant_user_id);
        if (!u) continue;
        await sendCascade({
          orgId: budget.org_id,
          entityType: "service_charge",
          entityId: budget.id,
          // Business-initiated: we are telling them a statement is ready, not
          // answering them. The consent gate (0148) needs the person, and this
          // path already has it.
          recipientUserId: share.occupant_user_id,
          message: `Your ${budget.period} service charge statement for ${property?.name ?? "your property"} is ready: ${formatNaira(share.amount)}.`,
          phone: u.phone,
          email: u.email,
        });
      }
    }
  } catch (e) {
    console.error("Statement notification cascade failed:", e);
  }

  revalidatePath(`/dashboard/sc/${budgetId}`);
  revalidatePath("/dashboard/sc");
  return ok();
}
