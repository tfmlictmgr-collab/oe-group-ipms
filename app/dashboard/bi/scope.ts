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
    // 0309. The OEA Executive does the FM/PM work across the organisation, so
    // they see what an FM/PM sees — over every property.
    case "operations_executive":
      return { requests: true, vendorPerf: true, collection: false, liabilities: false, budget: true };
    // B7 v3.3: ops KPIs and managed vendors, "nothing financial". Same operational
    // shape as the FM/PM, minus the budget column — hence no `budget`.
    case "regional_manager":
      return { requests: true, vendorPerf: true, collection: false, liabilities: false, budget: false };
    case "finance_approver": // financial
      return { requests: false, vendorPerf: false, collection: true, liabilities: true, budget: true };
    // 0327. Requests on the properties they represent — never the collection,
    // liability or budget columns, which are money. The page also checks the
    // owner_rep.analytics switch before rendering anything.
    case "owner_representative":
      return { requests: true, vendorPerf: false, collection: false, liabilities: false, budget: false };
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

/**
 * The scope after the operator's switches (0327). The Owner Rep's analytics are
 * a capability of their own, so every surface that reads `biScope` for a page,
 * the console or the export asks this instead — one answer, three consumers.
 */
export async function effectiveBiScope(
  role: string | undefined,
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }> }
): Promise<BiScope> {
  const scope = biScope(role);
  if (role !== "owner_representative") return scope;
  const { data } = await supabase.rpc("has_permission", { p_capability: "owner_rep.analytics" });
  return data === true ? scope : NONE;
}
