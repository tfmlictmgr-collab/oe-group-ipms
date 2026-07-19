// Service-charge apportionment: split a shared cost across a property's units
// pro-rata by each unit's apportionment factor (e.g. floor area).
//
// NOTE: this is the conventional pro-rata-by-area method. The CLAUDE.md brief
// names sample SC + electricity-apportionment workbooks as the source of truth;
// reconcile these formulas against those files when they're available.

export type ApportionUnit = {
  id: string;
  label: string;
  factor: number;
  occupant_user_id?: string | null;
};

export type ApportionedShare = ApportionUnit & {
  pct: number; // share of total, 0..1
  amount: number; // rounded to 2dp; the set sums exactly to total
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function apportion(
  total: number,
  units: ApportionUnit[]
): ApportionedShare[] {
  const factorSum = units.reduce((a, u) => a + u.factor, 0);
  if (factorSum <= 0 || units.length === 0) {
    return units.map((u) => ({ ...u, pct: 0, amount: 0 }));
  }

  const shares = units.map((u) => {
    const pct = u.factor / factorSum;
    return { ...u, pct, amount: round2(total * pct) };
  });

  // Reconcile rounding drift so the shares sum exactly to `total`: push the
  // residual onto the unit with the largest factor.
  const roundedSum = shares.reduce((a, s) => a + s.amount, 0);
  const residual = round2(total - roundedSum);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < shares.length; i++) {
      if (shares[i].factor > shares[largest].factor) largest = i;
    }
    shares[largest].amount = round2(shares[largest].amount + residual);
  }

  return shares;
}
