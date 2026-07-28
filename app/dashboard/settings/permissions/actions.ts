"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";

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
  "tickets.read_all": ["finance_approver"],
  "assets.read": ["finance_approver"],
  "sc.read_all": ["finance_approver"],
  "properties.read_all": ["finance_approver"],
  "tickets.assign": ["facility_manager"],
  "tickets.close": ["facility_manager"],
  "assets.write": ["facility_manager"],
  "assets.import": ["facility_manager"],
  "vendors.write": ["facility_manager"],
  "vendors.evaluate": ["facility_manager"],
  "properties.write": ["facility_manager"],
  "units.assign_occupant": ["facility_manager"],
  "people.invite": ["facility_manager"],
  "vendors.read": ["facility_manager", "finance_approver"],
  "sc.manage": ["finance_approver"],
  "bi.read": ["facility_manager", "finance_approver", "property_owner"],
  "people.deactivate": [],
};

function b7Grants(role: string, capability: string): boolean {
  if (role === "admin") return true;
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
