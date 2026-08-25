// Service-charge apportionment: split a shared cost across a property's units
// pro-rata by each unit's occupied space (e.g. floor area).
//
// NOTE: this is the conventional pro-rata-by-area method. The CLAUDE.md brief
// names sample SC + electricity-apportionment workbooks as the source of truth;
// reconcile these formulas against those files when they're available.

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
};

export type ApportionedShare = ApportionUnit & {
  pct: number; // share of total, 0..1
  amount: number; // rounded to 2dp; the set sums exactly to total
};

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

export function apportion(
  total: number,
  units: ApportionUnit[]
): ApportionedShare[] {
  const weight = units.map(effectiveFactor);
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
