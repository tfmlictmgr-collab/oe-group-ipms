import type { DeliveryBrand } from "./brands";

// The same `facility_manager` role means different things by brand:
//   TFML (facilities management) → "Facilities Manager"
//   OEA  (property management)   → "Properties Manager"
// Permissions are identical, so this is presentation only — one role, one set of
// policies, a brand-appropriate label. Splitting it into two roles would double
// every RLS policy for no security gain.

const BASE_LABELS: Record<string, string> = {
  tenant: "Tenant",
  vendor: "Vendor",
  fm_ops_staff: "Operations Staff",
  facility_manager: "Facilities Manager",
  finance_approver: "Finance / Approver",
  property_owner: "Property Owner",
  admin: "Administrator",
  viewer: "Read-only Observer",
  regional_manager: "Regional Manager",
  executive: "Managing Director",
  payment_audit_approver: "Payment Auditor",
  payment_approver: "Payment Approver",
};

// Per-brand overrides. Only where the brand genuinely changes the job title.
const BRAND_LABELS: Partial<Record<DeliveryBrand, Record<string, string>>> = {
  OEA: {
    facility_manager: "Properties Manager",
    fm_ops_staff: "Property Operations Staff",
    regional_manager: "Regional Properties Manager",
    // OEA is a partnership; TFML is a company. Same role, same policies, the
    // title each organisation actually uses.
    executive: "Managing Partner",
  },
  TFML: {
    regional_manager: "Regional Facilities Manager",
  },
};

/**
 * Roles that may be issued through an invitation, in the order they are offered.
 *
 * ONE list. This was previously duplicated — a server-side validation array and
 * a separate array driving the dropdown — and adding `viewer` to the first
 * without the second produced a role that passed validation but was impossible
 * to select. Two lists that must agree will eventually disagree.
 */
export const INVITABLE_ROLES = [
  "facility_manager",
  "regional_manager",
  "fm_ops_staff",
  "finance_approver",
  "payment_audit_approver",
  "payment_approver",
  "property_owner",
  "tenant",
  "vendor",
  "viewer",
  "executive",
  "admin",
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * Invitation seniority. Mirrors `role_rank()` in the database (0078c) — the
 * database is the enforcement, this is what lets the form show only the roles a
 * person may actually issue.
 *
 * You may invite a role STRICTLY BELOW your own. That rule replaced a guard which
 * named one privileged role (`role <> 'admin'`) and therefore protected only the
 * roles that existed the day it was written: a facility manager could issue an
 * `executive`, the MD who co-approves payments above the threshold.
 *
 * A new role needs a rank here and in `role_rank()`. Two places, deliberately —
 * the database must stand alone, and the UI must not offer what the database will
 * refuse.
 */
export const ROLE_RANK: Record<string, number> = {
  admin: 100,
  executive: 90,
  finance_approver: 70,
  regional_manager: 60,
  facility_manager: 50,
  fm_ops_staff: 30,
  property_owner: 20,
  viewer: 15,
  vendor: 10,
  tenant: 10,
};

/**
 * The roles `inviterRole` may issue: below its own rank, plus the peer exception
 * for an administrator.
 *
 * An org with one administrator must be able to appoint a second. Without that,
 * the only route to a new admin is someone with database access — which is how a
 * standing "super admin" gets built, and this system deliberately has none.
 */
export function invitableBy(inviterRole: string | null | undefined): InvitableRole[] {
  const role = inviterRole ?? "";
  const mine = ROLE_RANK[role] ?? 0;
  return INVITABLE_ROLES.filter(
    (r) => (ROLE_RANK[r] ?? 0) < mine || (role === "admin" && r === "admin")
  );
}

/** One line of context for the roles whose scope is not obvious from the name. */
export const ROLE_HINTS: Partial<Record<string, string>> = {
  viewer:
    "Read-only, organisation-wide. Sees properties, assets, vendors and request volumes — never money, personal contact details, or the audit trail. Intended for someone outside the organisation.",
  finance_approver:
    "Sees and approves money: the client-funds ledger, collections, remittances and reconciliation.",
  fm_ops_staff: "Works the jobs dispatched to them. No financial access.",
  property_owner: "Their own portfolio only — summary, statements and vendor performance.",
  regional_manager:
    "Runs a region. Everything a facilities/properties manager does, plus inviting operational staff — all of it bounded to the region, project or site they are assigned to. No financial access.",
  executive:
    "Oversight for the Managing Director / Managing Partner. Sees everything finance sees and co-approves payments, including above the threshold. Cannot execute a remittance, change the approval threshold, or write to the ledger — authorising and disbursing stay in different hands.",
};

export function roleLabel(
  role: string | null | undefined,
  brand?: string | null
): string {
  const r = role ?? "";
  const b = brand as DeliveryBrand | undefined;
  return (
    (b && BRAND_LABELS[b]?.[r]) ??
    BASE_LABELS[r] ??
    r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Short form used where space is tight (e.g. "FM" vs "PM"). */
export function roleAbbrev(role: string | null | undefined, brand?: string | null): string {
  if (role !== "facility_manager") return roleLabel(role, brand);
  return brand === "OEA" ? "PM" : "FM";
}
