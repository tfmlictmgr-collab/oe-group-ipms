// The three roles a vendor company gives its own people, and the capability
// set each one means.
//
// ⚠️ This is a PRESET LAYER, not a replacement for the four capabilities.
// Decision 17 fixed `manage_users`, `manage_profile`, `manage_work` and
// `manage_contracts` by migration and made them configurable by nobody; eleven
// live policies and functions resolve them through `vendor_user_can()`, and
// `submit_vendor_invoice` is one of them. Nothing here touches that. A role is
// a named set of those capabilities — what a person PICKS — and the capability
// is still what the database ENFORCES.
//
// Keeping the capability the enforcement primitive is also what lets this
// change carry existing rows: a membership whose set matches no preset is
// reported as `custom` and left exactly as it is, rather than being rounded to
// the nearest role by a migration that would be silently changing what somebody
// may do.
//
// ONE definition, because the invite form, the people list and the server
// action all need the same answer, and three copies of a permission mapping is
// how they come to disagree.

export const VENDOR_CAPABILITY_KEYS = [
  "manage_users",
  "manage_profile",
  "manage_work",
  "manage_contracts",
] as const;

export type VendorCapability = (typeof VENDOR_CAPABILITY_KEYS)[number];

/** The roles a vendor may ASSIGN. `owner` is deliberately not among them. */
export const ASSIGNABLE_VENDOR_ROLES = ["member", "admin"] as const;
export type AssignableVendorRole = (typeof ASSIGNABLE_VENDOR_ROLES)[number];

/** Every role a membership can READ as, including the two it cannot be set to. */
export type VendorRole = AssignableVendorRole | "owner" | "custom";

/**
 * What each assignable role grants.
 *
 * `member` is the least: the work itself and nothing about the company.
 * `admin` runs the company's side of the relationship — its people, its work
 * and its contracts — but NOT `manage_profile`. That is deliberate and it is
 * the board's split: editing the registration is editing the evidence a
 * managing organisation verified, so it stays with the owner.
 */
export const VENDOR_ROLE_CAPABILITIES: Record<AssignableVendorRole, VendorCapability[]> = {
  member: ["manage_work"],
  admin: ["manage_users", "manage_work", "manage_contracts"],
};

export const VENDOR_ROLE_LABEL: Record<VendorRole, string> = {
  member: "Member",
  admin: "Admin",
  owner: "Owner",
  custom: "Custom",
};

export const VENDOR_ROLE_HINT: Record<VendorRole, string> = {
  member: "Accept, decline and complete jobs, and submit invoices. Nothing about the company itself.",
  admin: "Everything a member may do, plus inviting colleagues and acting on contracts and introductions.",
  owner: "All four permanently, including editing the company registration. Changed by the managing organisation, not here.",
  custom:
    "A combination that predates roles, or one an administrator set directly. Choosing a role below replaces it.",
};

/**
 * The role a membership reads as.
 *
 * An owner is an owner whatever their array says — `vendor_user_can` short
 * circuits on `is_owner`, so the array is not consulted for them and must not
 * be consulted here either.
 *
 * Anything that is not exactly a preset is `custom`. Exact, not "close enough":
 * a set holding `manage_contracts` alone is not an admin who happens to be
 * missing two things, and displaying it as one would misstate what that person
 * can actually do.
 */
export function vendorRoleOf(
  isOwner: boolean,
  capabilities: readonly string[] | null | undefined
): VendorRole {
  if (isOwner) return "owner";
  const held = new Set(capabilities ?? []);
  for (const role of ASSIGNABLE_VENDOR_ROLES) {
    const want = VENDOR_ROLE_CAPABILITIES[role];
    if (held.size === want.length && want.every((c) => held.has(c))) return role;
  }
  return "custom";
}

/** Whether a string is a role a vendor may actually assign. Used server-side. */
export function isAssignableVendorRole(v: unknown): v is AssignableVendorRole {
  return typeof v === "string" && (ASSIGNABLE_VENDOR_ROLES as readonly string[]).includes(v);
}

/** The capabilities a role means, for a server action to write. */
export function capabilitiesForVendorRole(role: AssignableVendorRole): VendorCapability[] {
  return [...VENDOR_ROLE_CAPABILITIES[role]];
}
