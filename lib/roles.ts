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
};

// Per-brand overrides. Only where the brand genuinely changes the job title.
const BRAND_LABELS: Partial<Record<DeliveryBrand, Record<string, string>>> = {
  OEA: {
    facility_manager: "Properties Manager",
    fm_ops_staff: "Property Operations Staff",
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
  "fm_ops_staff",
  "finance_approver",
  "property_owner",
  "tenant",
  "vendor",
  "viewer",
  "admin",
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** One line of context for the roles whose scope is not obvious from the name. */
export const ROLE_HINTS: Partial<Record<string, string>> = {
  viewer:
    "Read-only, organisation-wide. Sees properties, assets, vendors and request volumes — never money, personal contact details, or the audit trail. Intended for someone outside the organisation.",
  finance_approver:
    "Sees and approves money: the client-funds ledger, collections, remittances and reconciliation.",
  fm_ops_staff: "Works the jobs dispatched to them. No financial access.",
  property_owner: "Their own portfolio only — summary, statements and vendor performance.",
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
