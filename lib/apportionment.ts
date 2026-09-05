// Service-charge apportionment: split a shared cost across a property's units.
//
// Three methods (0227), and the first is the original:
//
//   `area`   — pro-rata by occupied space × quantity. Every budget written
//              before 0227 is this, it is the default, and NOTHING about it
//              changed when the other two were added. The suites that exercise
//              it run the same arithmetic they always did.
//   `equal`  — per unit, ignoring size. How a small estate actually splits
//              security and waste: the guard costs the same whatever the floor
//              area behind the door.
//   `manual` — a person states each unit's amount. Not computed here at all;
//              `apportion` is handed the stated amounts and its only job is to
//              report them with their derived percentages, so one function
//              still produces every share in the system.
//
// NOTE: the CLAUDE.md brief names sample SC + electricity-apportionment
// workbooks as the source of truth; reconcile these formulas against those
// files when they're available. `manual` is the escape hatch until then — a
// person can state what the workbook says without waiting for it to be encoded.

/** Mirrors the `sc_apportion_method` enum (0227). */
export type ApportionMethod = "area" | "equal" | "manual";

export type ApportionUnit = {
  id: string;
  label: string;
  /** Occupied space in m², PER unit — not the row's total. */
  factor: number;
  /**
   * How many physical units this row stands for (0198). One row can be 12
   * stalls. Optional so every existing caller keeps working unchanged, and
   * absent means 1 — which is what every row written before 0198 is.
   */
  quantity?: number | null;
  occupant_user_id?: string | null;
  /**
   * The amount a person stated for this unit. Read only when the method is
   * `manual`, and ignored entirely otherwise — so a stale stated share left
   * behind by a method change can never leak into a computed split.
   */
  statedAmount?: number | null;
  /**
   * The distinguisher between same-type units (0198/0200) — "4" on a unit
   * labelled "Office Suite". Optional, and carried through untouched: `apportion`
   * spreads every input field onto its output, so a caller that never reads it
   * (nothing here does) pays nothing for it being present.
   */
  description?: string | null;
};

export type ApportionedShare = ApportionUnit & {
  pct: number; // share of total, 0..1
  amount: number; // rounded to 2dp; the set sums exactly to total
};

/**
 * How a unit is named to a person: the type, then its distinguisher.
 *
 * ⚠️ Mirrors `unit_display_label()` (SQL, 0200) exactly — trim/blank rule and
 * all — rather than inventing a second naming convention in TypeScript. A unit
 * printed as "Office Suite - 4" on the tenancy schedule and "Office Suite 4" on
 * a service-charge invoice would read as two different systems disagreeing
 * about the same suite.
 *
 * Needed here, in TS, because `generateInvoices` builds `property_or_unit` from
 * plain JS objects it already holds after apportioning — there is no row for
 * PostgREST to embed a SQL function into at that point. Every other consumer
 * (the tenancy schedule, the vacant-units picker) calls the database function
 * directly on a live query; this is the one place that cannot, and this is
 * therefore the one legitimate mirror. Do not add a second.
 */
export function unitDisplayLabel(label: string, description?: string | null): string {
  const d = (description ?? "").trim();
  return d ? `${label} - ${d}` : label;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * What this row actually weighs in the split.
 *
 * ⚠️ The area is PER unit, so a row of 12 stalls at 20 m² weighs 240, not 20.
 * Reading `factor` alone would give eleven of those stalls a free ride and
 * redistribute their share across the rest of the building without telling
 * anyone — the same harm the positive-factor constraint (0056) exists to
 * prevent, reached from a different direction.
 *
 * A missing, null, zero or negative quantity resolves to 1 rather than
 * throwing. The database constrains it to >= 1 (`units_quantity_positive`);
 * this is the belt for callers that build a unit literal by hand, and 1 is the
 * only safe default — 0 would erase the row from the split entirely.
 */
export function effectiveFactor(u: Pick<ApportionUnit, "factor" | "quantity">): number {
  const q = u.quantity == null || !Number.isFinite(u.quantity) || u.quantity < 1
    ? 1
    : Math.floor(u.quantity);
  return u.factor * q;
}

/**
 * What one row weighs under `equal`: its quantity, and nothing about its size.
 *
 * ⚠️ Quantity, NOT a literal 1 — even though `units_quantity_is_one` (0200)
 * currently pins every row to exactly one unit, so the two are identical today.
 * The reason to route through it anyway is that `effectiveFactor` is the one
 * place this codebase answers "how many units is this row", and 0198 shipped a
 * `vacant_count` that answered it independently, counted ROWS, and let eleven
 * of twelve stalls become unlettable. If that constraint is ever relaxed,
 * `equal` should mean equal per unit without anyone having to remember this
 * file exists.
 */
function equalWeight(u: Pick<ApportionUnit, "factor" | "quantity">): number {
  return effectiveFactor({ factor: 1, quantity: u.quantity });
}

export function apportion(
  total: number,
  units: ApportionUnit[],
  method: ApportionMethod = "area"
): ApportionedShare[] {
  // `manual` computes nothing. The amounts were decided by a person; this
  // reports them, deriving each percentage for display only. It deliberately
  // does NOT reconcile a shortfall onto the largest unit the way the computed
  // methods do — silently moving somebody's stated share to somebody else is
  // precisely what stating it by hand was meant to prevent. Whether the set
  // reconciles is `sc_manual_shares_state()`'s question, asked before anything
  // reaches this function.
  if (method === "manual") {
    const stated = units.map((u) => Math.max(0, Number(u.statedAmount ?? 0)));
    const statedSum = stated.reduce((a, n) => a + n, 0);
    return units.map((u, i) => ({
      ...u,
      pct: statedSum > 0 ? stated[i] / statedSum : 0,
      amount: round2(stated[i]),
    }));
  }

  const weight = units.map(method === "equal" ? equalWeight : effectiveFactor);
  const factorSum = weight.reduce((a, w) => a + w, 0);
  if (factorSum <= 0 || units.length === 0) {
    return units.map((u) => ({ ...u, pct: 0, amount: 0 }));
  }

  const shares = units.map((u, i) => {
    const pct = weight[i] / factorSum;
    return { ...u, pct, amount: round2(total * pct) };
  });

  // Reconcile rounding drift so the shares sum exactly to `total`: push the
  // residual onto the unit with the largest weight.
  //
  // ⚠️ Largest EFFECTIVE weight, not largest `factor`. A single 200 m² flat and
  // a row of 12 stalls at 20 m² would otherwise send the residual to the flat
  // while the stalls carry more of the building — a kobo either way, but the
  // rule should say what it means.
  const roundedSum = shares.reduce((a, s) => a + s.amount, 0);
  const residual = round2(total - roundedSum);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < shares.length; i++) {
      if (weight[i] > weight[largest]) largest = i;
    }
    shares[largest].amount = round2(shares[largest].amount + residual);
  }

  return shares;
}
