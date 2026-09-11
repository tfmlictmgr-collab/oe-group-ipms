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

// ⚠️ B7 used to be restated HERE, as a TypeScript copy of the database seed,
// and it had fallen five changes behind it: `records.export` was missing (so an
// administrator badged as MATCHING a baseline that denies it), the regional
// manager's `hierarchy.write` / `sc.manage` / `leases.write` were missing (so a
// correct baseline badged as drift), and — worst — the copy claimed B7 granted
// that role `applications.review_all`, which the database has never granted and
// which `0205` says must never be added, because it is the one capability in
// that arm not bounded by property scoping. The badge exists to make deliberate
// drift visible; one that is itself adrift trains people to ignore it.
//
// `b7_baseline()` (0244) is now the single definition, computed by the same
// `b7_grants()` the seeder provisions from. Decision 24's "two copies of one
// list will disagree, and did" — closed by deleting the copy.

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

  const [{ data: caps }, { data: rows }, { data: orgs }, { data: baseline }] =
    await Promise.all([
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
    supabase.rpc("b7_baseline"),
  ]);

  const matrix = (rows ?? []) as MatrixRow[];

  // A row the baseline does not mention cannot be judged, so it is not badged.
  // That is deliberate: a capability added after this org was provisioned has
  // no B7 position yet, and inventing one would be the same guess the deleted
  // copy was making.
  const b7 = new Map<string, boolean>();
  for (const b of (baseline ?? []) as { role: string; capability: string; granted: boolean }[]) {
    b7.set(`${b.role}:${b.capability}`, b.granted);
  }
  const deviations = matrix
    .filter((r) => {
      const expected = b7.get(`${r.role}:${r.capability}`);
      return expected !== undefined && r.granted !== expected;
    })
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
