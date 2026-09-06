"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import {
  validateTenancyCsv,
  type ImportContext,
  type ValidatedRow,
} from "@/lib/tenancy-import";

/**
 * Bulk import for the tenancy schedule (0265).
 *
 * Two acts, deliberately: PREVIEW every row and say exactly what will happen,
 * then COMMIT. A rent roll decides what real people are billed, and an import
 * that just runs is one nobody checked.
 *
 * ⚠️ The commit re-runs the SAME validator server-side rather than trusting the
 * browser's preview. The client could have been tampered with, and — the case
 * that actually happens — a unit may have been let by somebody else in the
 * minutes between the two.
 */

/** The lookups the validator resolves names against, scoped to this caller. */
async function buildContext(): Promise<{
  ctx: ImportContext;
  propertyNames: string[];
  canWrite: boolean;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("buildContext called without a session");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me) throw new Error("buildContext: signed-in user has no profile row");

  const [canWriteRes, propsRes, unitsRes, tenantsRes, leasesRes] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
    // ⚠️ `current_user_property_ids()` rather than a hand-rolled stakeholder
    // query — decision 8's one resolver. It answers for a node assignment as
    // well as a direct one, so a regional manager importing across their region
    // is offered exactly what `leases_write` will accept from them.
    supabase.rpc("current_user_property_ids"),
    supabase.from("units").select("id, label, property_id"),
    supabase.from("users").select("id, email").eq("role", "tenant").is("deactivated_at", null),
    // Live tenancies, for the duplicate check the exclusion constraint cannot
    // make on drafts. Soft-deleted ones are excluded exactly as the constraint
    // excludes them.
    supabase
      .from("leases")
      .select("unit_id, start_date, end_date, status")
      .is("deleted_at", null)
      .in("status", ["active", "renewed"]),
  ]);

  const { data: allProps } = await supabase
    .from("properties").select("id, name").is("deleted_at", null).order("name");

  // Oversight writes anywhere in the org; everyone else writes on the places
  // they hold. The same disjunction `leases_write` uses, so the preview cannot
  // validate a row the insert would refuse.
  const scoped = new Set(
    ((canWriteRes.data ? (propsRes.data as unknown as string[] | { current_user_property_ids: string }[]) : []) ?? [])
      .map((v) => (typeof v === "string" ? v : v.current_user_property_ids))
  );
  const isOversight = ["admin", "finance_approver", "executive", "payment_approver"].includes(me.role);
  const writable = (allProps ?? []).filter((p) => isOversight || scoped.has(p.id));
  const writableIds = new Set(writable.map((p) => p.id));

  // Built from the PAIRS, before a Map collapses them — the only point at which
  // a duplicate property name is still visible.
  const pairs = writable.map((p) => [p.name.toLowerCase(), p.id] as [string, string]);
  const ambiguous = new Set(
    pairs.map(([n]) => n).filter((n, i, all) => all.indexOf(n) !== i)
  );

  const occupied = new Map<string, { start: string; end: string }[]>();
  for (const l of (leasesRes.data ?? []) as { unit_id: string; start_date: string; end_date: string }[]) {
    const list = occupied.get(l.unit_id) ?? [];
    list.push({ start: l.start_date, end: l.end_date });
    occupied.set(l.unit_id, list);
  }

  return {
    ctx: {
      propertiesByName: new Map(pairs),
      ambiguousPropertyNames: ambiguous,
      unitsByKey: new Map(
        ((unitsRes.data ?? []) as { id: string; label: string; property_id: string }[])
          .filter((u) => writableIds.has(u.property_id))
          .map((u) => [`${u.property_id}::${u.label.toLowerCase()}`, u.id] as [string, string])
      ),
      tenantsByEmail: new Map(
        ((tenantsRes.data ?? []) as { id: string; email: string | null }[])
          .filter((u) => u.email)
          .map((u) => [u.email!.toLowerCase(), u.id] as [string, string])
      ),
      occupiedRanges: occupied,
    },
    propertyNames: writable.map((p) => p.name),
    canWrite: Boolean(canWriteRes.data),
  };
}

export type PreviewRow = Pick<ValidatedRow, "rowNumber" | "display" | "issues" | "valid">;

export async function previewTenancyImport(csvText: string): Promise<
  ActionResult<{
    rows: PreviewRow[];
    headerIssues: string[];
    validCount: number;
    willActivate: number;
    linkedToAccounts: number;
  }>
> {
  const { ctx, canWrite } = await buildContext();
  if (!canWrite) {
    return fail(
      "You cannot record tenancies.",
      "Importing a rent roll is the same act as recording one, at scale — it needs the same permission."
    );
  }

  const { rows, headerIssues } = validateTenancyCsv(csvText, ctx);
  const valid = rows.filter((r) => r.valid);

  return ok({
    rows: rows.map((r) => ({
      rowNumber: r.rowNumber, display: r.display, issues: r.issues, valid: r.valid,
    })),
    headerIssues,
    validCount: valid.length,
    willActivate: valid.filter((r) => r.values.activate === true).length,
    linkedToAccounts: valid.filter((r) => r.values.tenant_user_id).length,
  });
}

export async function commitTenancyImport(csvText: string): Promise<
  ActionResult<{ inserted: number; activated: number }>
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { ctx, canWrite } = await buildContext();
  if (!canWrite) return fail("You cannot record tenancies.");

  // Re-validated here, never taken from the preview.
  const { rows, headerIssues } = validateTenancyCsv(csvText, ctx);
  if (headerIssues.some((h) => h.startsWith("Missing required"))) {
    return fail(headerIssues.filter((h) => h.startsWith("Missing")).join(" "));
  }

  const invalid = rows.filter((r) => !r.valid);
  if (invalid.length > 0) {
    // ⚠️ Refused whole rather than importing the good rows. The person is
    // looking at a rent roll they believe they have checked; importing 187 of
    // 200 and leaving them to work out which 13 are missing is how a portfolio
    // ends up quietly incomplete. `import_tenancies` is one transaction for the
    // same reason.
    return fail(
      `${invalid.length} of ${rows.length} rows still have a problem, so nothing was imported.`,
      `The first is row ${invalid[0].rowNumber}: ${invalid[0].issues[0]?.message ?? "see the preview"}`
    );
  }
  if (rows.length === 0) return fail("There is nothing in that file to import.");

  const { data, error } = await supabase.rpc("import_tenancies", {
    p_rows: rows.map((r) => r.values),
  });
  if (error) {
    // The function names the offending row and says nothing has been imported;
    // that is written for the reader and is shown as-is.
    return failFromDb(error, "import those tenancies");
  }

  const result = data as { inserted: number; activated: number };
  revalidatePath("/dashboard/schedule");
  revalidatePath("/dashboard/leases");
  return ok({ inserted: result.inserted, activated: result.activated });
}
