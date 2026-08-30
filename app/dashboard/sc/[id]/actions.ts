"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { apportion, type ApportionMethod } from "@/lib/apportionment";
import { sendCascade } from "@/lib/cascade";
import { flattenTemplateVar, firstNameTemplateVar } from "@/lib/notify";
import { formatNaira } from "@/lib/currency";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Generates (or regenerates) per-unit service-charge invoices for a budget by
// apportioning its total across the property's units. Runs under the caller's
// session, so RLS enforces that only admin/finance can do this.
export async function generateInvoices(budgetId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: budget, error: bErr } = await supabase
    .from("sc_budgets")
    .select("id, org_id, property_id, period, total_amount, apportion_method")
    .eq("id", budgetId)
    .single();
  if (bErr || !budget) return fail("That budget could not be found.");

  const method = ((budget as { apportion_method?: string }).apportion_method ??
    "area") as ApportionMethod;

  // ⚠️ A manual split is REFUSED here unless it reconciles to the kobo and every
  // unit has been stated. The computed methods guarantee that by construction —
  // `apportion()` pushes the rounding residual onto the largest weight — and a
  // stated split has no such construction, so the guard has to be explicit.
  //
  // The question is asked of `sc_manual_shares_state()`, which is the same
  // function the budget screen reads to show the running variance. One answer,
  // two consumers: a person cannot be shown "reconciles" and then refused, or
  // shown a shortfall and allowed through. That is decision 22's lesson —
  // "vacant" had two definitions free to disagree, and they did — applied
  // before the second definition exists rather than after.
  let manualShares = new Map<string, number>();
  if (method === "manual") {
    const { data: stateRows, error: stateErr } = await supabase.rpc(
      "sc_manual_shares_state", { p_budget_id: budgetId }
    );
    if (stateErr) return failFromDb(stateErr, "check this manual apportionment");
    const state = (Array.isArray(stateRows) ? stateRows[0] : stateRows) as {
      budget_total: number; stated_total: number; variance: number;
      unit_count: number; stated_units: number; missing_units: number;
      reconciles: boolean;
    } | null;

    if (!state || !state.reconciles) {
      const variance = Number(state?.variance ?? 0);
      const missing = Number(state?.missing_units ?? 0);
      return fail(
        missing > 0
          ? `${missing} unit${missing === 1 ? " has" : "s have"} no stated share.`
          : `The stated shares are ${formatNaira(Math.abs(variance))} ${variance > 0 ? "short of" : "over"} the budget total.`,
        "A manual apportionment has to account for every unit and add up to the budget exactly. Nothing has been invoiced."
      );
    }

    const { data: shares } = await supabase
      .from("sc_budget_shares").select("unit_id, amount").eq("budget_id", budgetId);
    manualShares = new Map(
      (shares ?? []).map((s) => [s.unit_id as string, Number(s.amount)])
    );
  }

  const { data: property } = await supabase
    .from("properties")
    .select("name")
    .eq("id", budget.property_id)
    .single();

  const { data: units, error: uErr } = await supabase
    .from("units")
    .select("id, label, apportionment_factor, unit_quantity, occupant_user_id")
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
      // 0198: the area is PER unit, so a row of 12 stalls weighs 12x it.
      quantity: Number(u.unit_quantity ?? 1),
      occupant_user_id: u.occupant_user_id,
      statedAmount: manualShares.get(u.id) ?? null,
    })),
    method
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
    // Snapshotted onto the invoice, for the same reason the fee rate is
    // snapshotted onto a rent charge (decision 14): changing the budget's
    // method later must not silently rewrite what a past bill says it was.
    apportion_method: method,
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
      // `full_name` is new here (WHATSAPP_TEMPLATES.md §3's {{1}}); `phone`
      // was already selected but, like the payment-approval site, was never
      // passed as `whatsapp:` below — WhatsApp was never attempted for a
      // statement-ready notice regardless of the occupant's own preference.
      const { data: occupants } = await supabase
        .from("users")
        .select("id, full_name, email, phone")
        .in("id", occupantIds);
      // {{3}} — flattened once per property, not per share, since it does not
      // vary within this loop. `property?.name` keeps the same "your property"
      // fallback the free-text message already used.
      const propertyName = flattenTemplateVar(property?.name, "your property");
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
          whatsapp: u.phone,
          whatsappTemplate: {
            name: "service_charge_ready",
            languageCode: "en",
            variables: [
              firstNameTemplateVar(u.full_name),
              flattenTemplateVar(String(budget.period), "this period", 30),
              propertyName,
              formatNaira(share.amount),
            ],
          },
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

// ── How the budget is split, and who says so ──────────────────────────────
//
// Both writes run under the caller's own session. `sc_budgets_update` and
// `sc_budget_shares_write` both require `has_permission('sc.manage')`, so the
// database decides; the checks here exist to produce a sentence a person can
// act on, never as the boundary.

export type ShareInput = { unitId: string; amount: number; note?: string };

/**
 * Sets how a budget is apportioned.
 *
 * ⚠️ Refused once the budget has been invoiced. Changing the method on an
 * invoiced budget would leave every existing `service_charges` row carrying a
 * snapshot that no longer matches its parent — the invoice would say one thing
 * and the budget another, and a tenant querying their bill would be shown a
 * method their charge was not raised under. Regenerating is the deliberate act
 * that changes what people are billed, and it has its own guard.
 */
export async function setApportionMethod(
  budgetId: string,
  method: ApportionMethod
): Promise<ActionResult> {
  const supabase = await createClient();

  if (!["area", "equal", "manual"].includes(method)) {
    // Refused rather than coerced. An unrecognised value means the form and the
    // enum have drifted, and quietly falling back to `area` would be an
    // apportionment decision made by a typo — the same reasoning `createLease`
    // applies to the admin-fee basis.
    return fail("That is not a way of splitting a service charge.");
  }

  const { data: budget } = await supabase
    .from("sc_budgets").select("id, status").eq("id", budgetId).maybeSingle();
  if (!budget) return fail("That budget could not be found.");
  if (budget.status === "invoiced") {
    return fail(
      "This budget has already been invoiced, so how it was split is now a matter of record.",
      "Every invoice carries the method it was raised under. To change it, regenerate the invoices — which is what actually changes what people are billed."
    );
  }

  // ⚠️ `.select()` is what makes this honest. An UPDATE that RLS declines
  // matches zero rows and returns NO error, so without it this action reported
  // success on a write that did nothing — the pattern decision 23 records
  // three times over (a storage path RLS declines, an UPDATE policy with no
  // grant, a supersede that matched nothing and returned no error).
  const { data: updated, error } = await supabase
    .from("sc_budgets")
    .update({ apportion_method: method })
    .eq("id", budgetId)
    .select("id");
  if (error) return failFromDb(error, "set how this budget is split");
  if (!updated || updated.length === 0) {
    return fail(
      "You do not have permission to change how this budget is split.",
      "Nothing has been saved. Setting the apportionment method needs sc.manage."
    );
  }

  revalidatePath(`/dashboard/sc/${budgetId}`);
  return ok();
}

/**
 * Records the stated shares for a manual apportionment.
 *
 * Saves whatever has been entered, INCLUDING a set that does not yet add up.
 * That is deliberate: a person apportioning fourteen units by hand cannot be
 * required to reach a reconciled total in one submission, and a form that
 * refuses partial work is a form people keep in a spreadsheet instead. The
 * reconciliation rule is enforced where it matters — at generation — and the
 * running variance is on screen throughout.
 */
export async function saveManualShares(
  budgetId: string,
  shares: ShareInput[]
): Promise<ActionResult<{ statedTotal: number; variance: number; reconciles: boolean }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const { data: budget } = await supabase
    .from("sc_budgets").select("id, property_id, status").eq("id", budgetId).maybeSingle();
  if (!budget) return fail("That budget could not be found.");
  if (budget.status === "invoiced") {
    return fail(
      "This budget has already been invoiced.",
      "Regenerate the invoices first if the split needs to change — that is the act that re-bills people, and it is refused outright once anything has been paid against it."
    );
  }

  for (const s of shares) {
    if (!Number.isFinite(s.amount) || s.amount < 0) {
      return fail("A stated share cannot be negative or blank.");
    }
  }

  // ⚠️ Every unit id is checked against THIS property before anything is
  // written. `sc_budget_shares_unit_same_org_fk` already stops a unit from
  // another organisation, and that is the security boundary; this stops a unit
  // from another property in the SAME org, which the foreign key cannot express
  // and which would put a share on a bill the budget has nothing to do with.
  const { data: units } = await supabase
    .from("units").select("id").eq("property_id", budget.property_id).is("deleted_at", null);
  const valid = new Set((units ?? []).map((u) => u.id as string));
  const stray = shares.filter((s) => !valid.has(s.unitId));
  if (stray.length > 0) {
    return fail(
      `${stray.length} of those units are not on this property.`,
      "Nothing has been saved. Reload the page — the unit list has probably changed since it was opened."
    );
  }

  const { error } = await supabase.from("sc_budget_shares").upsert(
    shares.map((s) => ({
      org_id: me.org_id,
      budget_id: budgetId,
      unit_id: s.unitId,
      amount: s.amount,
      note: s.note?.trim() || null,
      set_by: user.id,
    })),
    { onConflict: "budget_id,unit_id" }
  );
  if (error) return failFromDb(error, "save these shares");

  // ⚠️ Clear shares for units that are no longer on the property. Without this
  // a soft-deleted unit leaves its row behind, and `sc_manual_shares_state`
  // then counts MORE stated units than live ones: `reconciles` is false,
  // `missing_units` is 0 (it is a `greatest(…, 0)`), and the variance is 0 —
  // so generation refuses with "the stated shares are ₦0.00 over the budget
  // total", which is both untrue and impossible to act on. A share is a
  // statement about a unit; when the unit goes, so does the statement.
  if (valid.size > 0) {
    await supabase
      .from("sc_budget_shares")
      .delete()
      .eq("budget_id", budgetId)
      .not("unit_id", "in", `(${Array.from(valid).join(",")})`);
  }

  // Read the state back rather than computing it here, so the number the form
  // shows after saving is the same one that will decide whether generation is
  // allowed. Two answers to one question is how they end up disagreeing.
  const { data: stateRows } = await supabase.rpc(
    "sc_manual_shares_state", { p_budget_id: budgetId }
  );
  const state = (Array.isArray(stateRows) ? stateRows[0] : stateRows) as {
    stated_total: number; variance: number; reconciles: boolean;
  } | null;

  revalidatePath(`/dashboard/sc/${budgetId}`);
  return ok({
    statedTotal: Number(state?.stated_total ?? 0),
    variance: Number(state?.variance ?? 0),
    reconciles: Boolean(state?.reconciles),
  });
}
