import type { DeliveryBrand } from "./brands";

// ⚠️ `facility_manager` USED to mean different things by brand — "Facilities
// Manager" on TFML, "Properties Manager" on OEA — and this file argued that
// splitting it "would double every RLS policy for no security gain".
//
// That held while no organisation employed both at once. OEA now staffs
// facilities managers alongside its property managers (board, 21 Aug 2026), so
// a brand-aware label can no longer tell the two apart: they share a brand.
// `property_manager` is a real role as of 0182, and the OEA override is gone
// with it — on OEA, "Facilities Manager" now means a facilities manager.
//
// The cost turned out to be one array element, not thirty predicates, because
// `fm_roles()` has been the single operational resolver since 0078a.

const BASE_LABELS: Record<string, string> = {
  tenant: "Tenant",
  vendor: "Vendor",
  fm_ops_staff: "Operations Staff",
  facility_manager: "Facilities Manager",
  property_manager: "Properties Manager",
  // ⚠️ The IDENTIFIER stays `finance_approver` (decision 23: "label renamed").
  // The enum value is named in 123 files including `enforce_payment_transition`,
  // `submit_vendor_invoice`, `assert_may_disburse` and `oversight_roles()`;
  // renaming it is a mechanical rewrite of every money-path function body for a
  // display change, and 0183's lesson is that those rewrites are where a clause
  // gets lost. What the board renamed is what a person reads, and that is here.
  finance_approver: "Payment Officer",
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
 * The two peer managers, as one array.
 *
 * The app-layer twin of `fm_roles()` (0183) and it exists for the same reason:
 * when the FM/PM split landed there were 41 places in this codebase holding a
 * literal `["admin", "facility_manager"]`, and adding the new role to 41 arrays
 * by hand is how one screen silently keeps refusing a property manager six
 * months from now. Spread it — `["admin", ...FM_PM]` — rather than restating it.
 *
 * ⚠️ Deliberately WITHOUT `regional_manager`. That role supersedes both over a
 * wider place (0078a) and several of these call sites include it and several
 * do not; folding it in here would silently widen the ones that do not.
 */
export const FM_PM = ["facility_manager", "property_manager"] as const;

/**
 * Who may see money and the audit trail — the TypeScript mirror of the SQL
 * `oversight_roles()`.
 *
 * ⚠️ Decision 9 created that function for exactly one reason, in its own words:
 * "Who may see money and the audit trail is now ONE definition,
 * `oversight_roles()`, rather than the same role array repeated across 18
 * policies." The array then got repeated anyway — in TypeScript, four times
 * (`seesLedger`, `seesAudit`, Statements' `isStaff`, and the money-desk list) —
 * and drifted, because every one of those copies was written before `0151`
 * created `payment_approver` and before `0157`/`0246` admitted them to
 * oversight.
 *
 * The measured consequence, 5 Sept 2026: the payment approver could read 4,745
 * audit rows, 10 ledger accounts, 20 leases and 25 service charges through RLS,
 * and the product showed them none of it — no Client Funds link, no Audit Trail
 * link, and a Statements page that dropped them into the TENANT branch and
 * rendered blank. Nothing was refused; nothing was offered either.
 *
 * ⚠️ Still a hardcoded role list, deliberately, and NOT capability-derived:
 * decision 7 names ledger read and audit visibility among the non-delegable
 * controls that "stay hardwired and never appear as toggles". The fix is for
 * the hardcoded list to be RIGHT and to exist ONCE, not for it to become a
 * preference.
 *
 * `scripts/verify-portfolio-and-controls.mjs` asserts this equals the database
 * function, so the two cannot drift apart again in silence.
 */
export const OVERSIGHT_ROLES = [
  "admin",
  "finance_approver",
  "executive",
  "payment_approver",
] as const;

/** Does this role hold org-wide sight of money and the audit trail? */
export function isOversight(role: string | null | undefined): boolean {
  return (OVERSIGHT_ROLES as readonly string[]).includes(role ?? "");
}

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
  "property_manager",
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
  // The approval-chain roles (0151). Below finance and above the operational
  // staff, so a facility manager cannot mint the approver who signs off above
  // their own head. Absent from here they fell to the `?? 0` default, which is
  // exactly the drift this file's own comment warns about — the database had
  // ranked them since 0151 while this list had not.
  payment_approver: 65,
  payment_audit_approver: 64,
  regional_manager: 60,
  // Peers, not a hierarchy. Equal ranks cannot invite each other (the rule is
  // "strictly below your own"), which is the intent: a facilities manager has
  // no business appointing a property manager or the reverse. Mirrors
  // `role_rank()` in 0183.
  facility_manager: 50,
  property_manager: 50,
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
    "Releases money the approval chain has cleared: the client-funds ledger, collections, remittances and daily reconciliation. Does not approve — approval belongs to the chain, and the person who approved a payment may never also send it.",
  fm_ops_staff: "Works the jobs dispatched to them. No financial access.",
  facility_manager:
    "Maintenance, plant and services on the properties assigned to them — and on OEA, that is now a distinct job from the property manager's. Sees requests on their properties, dispatches them, and signs off the work.",
  property_manager:
    "Lettings, tenancies and owner relations on the properties assigned to them. Identical authority to a facilities manager over a different discipline; both sign off their own work only.",
  payment_audit_approver:
    "The audit check on the payment chain — on OEA it is the first stage, elsewhere the second. Checks an invoice against the job card, the evidence and the attachments before it reaches anyone with a spending limit, and sees every service request in order to do it. Nothing in the ledger.",
  payment_approver:
    "The last stage of the payment chain: final approval, bounded by an amount rather than by a place. Give them a tier — 1 approves up to the tier-1 limit, 2 up to the approval limit, 3 without limit. On OEA they are the only role at this stage, so the organisation needs one whose tier covers its largest payment.",
  property_owner: "Their own portfolio only — summary, statements and vendor performance.",
  regional_manager:
    "Runs a region. Everything a facilities/properties manager does, plus inviting operational staff — all of it bounded to the region, project or site they are assigned to. No financial access.",
  executive:
    "Oversight for the Managing Director / Managing Partner. Sees everything the payment officer sees and approves payments — on OEA, every outbound payment passes them, at every amount. Cannot execute a remittance, change the approval threshold, or write to the ledger: authorising and disbursing stay in different hands.",
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

/**
 * Short form used where space is tight.
 *
 * No longer brand-dependent: the two are separate roles now, so "FM" and "PM"
 * are read off the role itself. Previously this asked the BRAND, which is
 * exactly the assumption the split invalidated — on OEA it would have
 * abbreviated a facilities manager to "PM".
 */
export function roleAbbrev(role: string | null | undefined, brand?: string | null): string {
  if (role === "facility_manager") return "FM";
  if (role === "property_manager") return "PM";
  return roleLabel(role, brand);
}
