// The four groups People → Directory is organised by, and which role lands in
// which. Pure, so the directory page, the profile page and the Members list
// all put a person in the same group.
//
// 📌 The same four as `RecordDownloads` / `/api/records/export`, deliberately:
// the directory is the on-screen form of those CSVs, and a roster that groups
// people one way on screen and another way in the file is two definitions of
// "who is a tenant" free to drift.

export type DirectoryGroup = "staff" | "tenants" | "landlords" | "vendors";

export const DIRECTORY_GROUPS: { key: DirectoryGroup; label: string; exportType: string }[] = [
  { key: "staff", label: "Staff", exportType: "staff" },
  { key: "tenants", label: "Tenants", exportType: "tenant" },
  { key: "landlords", label: "Landlords / owners", exportType: "landlord" },
  { key: "vendors", label: "Vendors", exportType: "vendor" },
];

/** Roles that are counterparties rather than colleagues. Everyone else is staff. */
const NON_STAFF = new Set(["tenant", "property_owner", "vendor"]);

/** The roles a staff query excludes — same list the staff CSV excludes. */
export const NON_STAFF_ROLES = ["tenant", "property_owner", "vendor"] as const;

export function directoryGroupOf(role: string | null | undefined): DirectoryGroup {
  if (role === "tenant") return "tenants";
  if (role === "property_owner") return "landlords";
  if (role === "vendor") return "vendors";
  return "staff";
}

export function isStaffRole(role: string | null | undefined): boolean {
  return !NON_STAFF.has(role ?? "");
}

export function parseDirectoryGroup(v: string | string[] | undefined): DirectoryGroup {
  const s = Array.isArray(v) ? v[0] : v;
  return DIRECTORY_GROUPS.some((g) => g.key === s) ? (s as DirectoryGroup) : "staff";
}

/**
 * A tenancy is "current" while it is active or renewed — the same pair
 * `leases_no_overlap` treats as live. Expired and terminated tenancies stay on
 * the profile as history but never count as where somebody lives now.
 */
export function isLiveTenancy(status: string | null | undefined): boolean {
  return status === "active" || status === "renewed";
}

/**
 * Viewers who may see a tenant's MONEY on a profile — billed, received,
 * outstanding, payments made.
 *
 * ⚠️ Stated rather than left to RLS, because RLS answering "no rows" here
 * would render as "nothing billed", and decision 25 records why that is worse
 * than a refusal: a zero that means "you may not see this" is indistinguishable
 * from one that means "nothing was billed". `payment_intents_select` admits
 * oversight and `property_finance_roles()` (PM, RM — decision 29); a
 * facilities manager maintains plant and is deliberately not in either, so
 * the section is simply not shown to them rather than shown empty.
 */
export function seesTenantMoney(role: string | null | undefined): boolean {
  return [
    "admin", "finance_approver", "executive", "payment_approver",
    "property_manager", "regional_manager",
  ].includes(role ?? "");
}
