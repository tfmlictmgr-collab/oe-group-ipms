"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { FM_PM } from "@/lib/roles";

// The permission matrix editor.
//
// Every authority check here is a SECOND line, not the line. `set_role_permission`
// and `reset_org_permissions_to_b7` (0050/0053) verify operator status and
// administrator role themselves, because they are SECURITY DEFINER and a check
// that lives only in the application is a check that a direct API call skips.
// These exist so the UI can refuse early and say something useful.

export type Capability = {
  key: string;
  module: string;
  label: string;
  description: string;
  locked: boolean;
  locked_reason: string | null;
  sort_order: number;
};

export type MatrixRow = { role: string; capability: string; granted: boolean };

export type MatrixView = {
  /** Whether the CALLER may change anything, as opposed to merely read it. */
  canEdit: boolean;
  orgs: { id: string; name: string; is_platform_operator: boolean }[];
  capabilities: Capability[];
  rows: MatrixRow[];
  /** Capabilities differing from the B7 baseline, as `role:capability`. */
  deviations: string[];
};

/** B7, restated in one place so the badge and the reset agree on the baseline. */
const B7: Record<string, string[]> = {
  // ⚠️ Org-wide sight of the request queue moved off finance and onto the
  // payment auditor (board, 21 Aug 2026 — see 0184/0185). `admin` and
  // `executive` are not listed here because b7Grants() gives them everything
  // by role, not by capability. If this line and `request_read_all_roles()`
  // ever disagree, the "differs from B7" badge starts lying about which of the
  // two is the deviation.
  "tickets.read_all": ["payment_audit_approver"],
  "assets.read": ["finance_approver"],
  "sc.read_all": ["finance_approver"],
  "properties.read_all": ["finance_approver"],
  "tickets.assign": [...FM_PM],
  "tickets.close": [...FM_PM],
  "assets.write": [...FM_PM],
  "assets.import": [...FM_PM],
  "vendors.write": [...FM_PM],
  "vendors.evaluate": [...FM_PM],
  "properties.write": [...FM_PM],
  "units.assign_occupant": [...FM_PM],
  "people.invite": [...FM_PM],
  "vendors.read": [...FM_PM, "finance_approver"],
  "sc.manage": ["finance_approver"],
  "bi.read": [...FM_PM, "finance_approver", "property_owner"],
  "people.deactivate": [],
};

/**
 * Roles the database seed gives their OWN arm, rather than resolving through
 * the capability map above.
 *
 * ⚠️ Without these, `b7Grants` answered false for every capability an
 * executive, regional manager or payment-chain role legitimately holds — so the
 * matrix badged each of them as "differs from B7" when they matched B7
 * exactly. The badge is meant to make deliberate drift visible; one that cries
 * wolf on the baseline itself trains people to ignore it.
 *
 * Mirrors the role arms in `seed_b7_permissions` (0184), in the same order.
 */
const B7_BY_ROLE: Record<string, string[]> = {
  executive: [
    "tickets.read_all", "assets.read", "sc.read_all", "properties.read_all",
    "vendors.read", "bi.read", "tickets.triage_unassigned",
  ],
  payment_audit_approver: [
    "tickets.read_all", "vendors.read", "bi.read", "properties.read_all",
  ],
  payment_approver: ["vendors.read", "bi.read", "properties.read_all"],
  regional_manager: [
    "tickets.assign", "tickets.close", "tickets.triage_unassigned",
    "assets.write", "assets.import",
    "vendors.read", "vendors.write", "vendors.evaluate",
    "properties.write", "units.assign_occupant",
    "people.invite", "bi.read", "applications.review_all",
  ],
};

function b7Grants(role: string, capability: string): boolean {
  // Named and false before admin's blanket grant, exactly as the seed orders
  // it — an operator turns this on per org, for the exceptional case it exists
  // for (0178).
  if (capability === "tickets.assign_without_review") return false;
  if (role === "admin") return true;
  if (role in B7_BY_ROLE) return B7_BY_ROLE[role].includes(capability);
  return (B7[capability] ?? []).includes(role);
}

export async function loadMatrix(targetOrgId?: string): Promise<ActionResult<MatrixView>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me || me.role !== "admin") {
    return fail("Only an administrator can view the permission matrix.");
  }

  const { data: myOrg } = await supabase
    .from("orgs").select("id, name, is_platform_operator").eq("id", me.org_id).single();

  const isOperator = Boolean(myOrg?.is_platform_operator);

  // A brand administrator sees their OWN matrix, read-only. The operator sees
  // every org and may change any of them. Requesting another org's matrix
  // without being the operator is answered with your own, not an error — there
  // is nothing to leak and nothing to explain.
  const orgId = isOperator && targetOrgId ? targetOrgId : me.org_id;

  const [{ data: caps }, { data: rows }, { data: orgs }] = await Promise.all([
    supabase.from("capabilities").select("*").order("sort_order"),
    // Reading another org's rows needs the service role: role_permissions_select
    // is scoped to the caller's own org, deliberately. The operator check above
    // is what authorises this.
    isOperator
      ? (await import("@/lib/supabase/admin")).supabaseAdmin
          .from("role_permissions").select("role, capability, granted").eq("org_id", orgId)
      : supabase.from("role_permissions").select("role, capability, granted"),
    isOperator
      ? (await import("@/lib/supabase/admin")).supabaseAdmin
          .from("orgs").select("id, name, is_platform_operator").order("name")
      : Promise.resolve({ data: myOrg ? [myOrg] : [] }),
  ]);

  const matrix = (rows ?? []) as MatrixRow[];
  const deviations = matrix
    .filter((r) => r.granted !== b7Grants(r.role, r.capability))
    .map((r) => `${r.role}:${r.capability}`);

  return ok({
    canEdit: isOperator,
    orgs: (orgs ?? []) as MatrixView["orgs"],
    capabilities: (caps ?? []) as Capability[],
    rows: matrix,
    deviations,
  });
}

export async function setPermission(
  orgId: string,
  role: string,
  capability: string,
  granted: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_role_permission", {
    p_org_id: orgId,
    p_role: role,
    p_capability: capability,
    p_granted: granted,
  });

  // The function's refusals are written for a person — "permissions are set on
  // the OE Group operator portal, not here" says more than a 403 would.
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/dashboard/settings/permissions");
  return ok();
}

export async function resetToB7(orgId: string): Promise<ActionResult<{ changed: number }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reset_org_permissions_to_b7", {
    p_org_id: orgId,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/dashboard/settings/permissions");
  return ok({ changed: Number(data ?? 0) });
}
