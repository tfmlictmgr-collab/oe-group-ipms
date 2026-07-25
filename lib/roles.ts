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
};

// Per-brand overrides. Only where the brand genuinely changes the job title.
const BRAND_LABELS: Partial<Record<DeliveryBrand, Record<string, string>>> = {
  OEA: {
    facility_manager: "Properties Manager",
    fm_ops_staff: "Property Operations Staff",
  },
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
