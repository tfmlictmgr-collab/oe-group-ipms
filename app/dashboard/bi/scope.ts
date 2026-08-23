// Which BI widgets a role may see — the B7 "Exec / BI dashboard" column.
//
// ⚠️ ONE definition, imported by the executive dashboard AND the analytics
// console. It was a private function inside `page.tsx` until the console needed
// the same rule; copying it would have produced two matrices that drift, which
// is the mistake `current_user_property_ids()` and `oversight_roles()` were both
// created to stop.
//
// This is presentation only. Every underlying query is RLS-scoped, so an FM/PM
// or owner sees their own properties' figures whatever this returns — hiding a
// widget is a courtesy, the database is the boundary.

export type BiScope = {
  requests: boolean;
  vendorPerf: boolean;
  collection: boolean;
  liabilities: boolean;
  budget: boolean;
};

const NONE: BiScope = {
  requests: false, vendorPerf: false, collection: false, liabilities: false, budget: false,
};

export function biScope(role: string | undefined): BiScope {
  switch (role) {
    case "admin":
      return { requests: true, vendorPerf: true, collection: true, liabilities: true, budget: true };
    // B7 v3.3: "All (RT)" on every column. An executive sees everything finance
    // sees; what they may not do — execute a remittance, move the threshold — is
    // enforced in `enforce_payment_transition()`, not by blinding a dashboard.
    case "executive":
      return { requests: true, vendorPerf: true, collection: true, liabilities: true, budget: true };
    // Both peer managers, one arm. A property manager runs the same ops KPIs
    // and the same operational budgets over a different discipline.
    case "facility_manager":
    case "property_manager":
      return { requests: true, vendorPerf: true, collection: false, liabilities: false, budget: true };
    // B7 v3.3: ops KPIs and managed vendors, "nothing financial". Same operational
    // shape as the FM/PM, minus the budget column — hence no `budget`.
    case "regional_manager":
      return { requests: true, vendorPerf: true, collection: false, liabilities: false, budget: false };
    case "finance_approver": // financial
      return { requests: false, vendorPerf: false, collection: true, liabilities: true, budget: true };
    case "property_owner": // own portfolio (RLS-scoped to owned properties)
      return { requests: true, vendorPerf: false, collection: true, liabilities: false, budget: true };
    default:
      return NONE;
  }
}

/** Whether the role reaches the BI section at all. */
export function seesBi(role: string | undefined): boolean {
  const s = biScope(role);
  return s.requests || s.vendorPerf || s.collection || s.liabilities || s.budget;
}
