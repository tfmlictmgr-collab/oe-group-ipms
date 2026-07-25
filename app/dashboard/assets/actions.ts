"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { validateAssetCsv, type ImportContext } from "@/lib/asset-import";
import { ASSET_FIELDS } from "@/lib/asset-schema";

// Every write below goes through the caller's own session, so RLS decides what
// is permitted. Nothing here uses the service role — the UI cannot grant itself
// access the database would refuse.

/**
 * Properties the caller may CREATE ASSETS on. Properties are readable org-wide,
 * but asset writes are restricted to the ones an FM/PM is staked to — so every
 * property picker and import lookup must use this, not a plain properties read.
 * Otherwise the UI offers a choice the database will refuse.
 */
export async function writableProperties(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const [{ data: me }, { data: props }, { data: stakes }] = await Promise.all([
    supabase.from("users").select("role").eq("id", user.id).single(),
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("property_stakeholders").select("property_id").eq("user_id", user.id),
  ]);

  if (me?.role === "admin") return props ?? [];
  const staked = new Set((stakes ?? []).map((s) => s.property_id));
  return (props ?? []).filter((p) => staked.has(p.id));
}

/**
 * Builds the lookup maps the importer resolves names against, using ONLY what
 * the caller can write to. A property the FM/PM doesn't manage never enters the
 * map, so an import row naming it fails validation before any write is attempted.
 */
export async function buildImportContext(): Promise<{
  ctx: {
    properties: [string, string][];
    units: [string, string][];
    vendors: [string, string][];
    users: [string, string][];
    existingTags: string[];
    customFieldKeys: string[];
  };
  propertyNames: string[];
}> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me) throw new Error("Could not resolve your profile.");

  const [propsRes, unitsRes, vendorsRes, usersRes, assetsRes, defsRes, stakeRes] =
    await Promise.all([
      supabase.from("properties").select("id, name").order("name"),
      supabase.from("units").select("id, label, property_id"),
      supabase.from("vendors").select("id, name"),
      supabase.from("users").select("id, email"),
      supabase.from("assets").select("asset_tag"),
      supabase.from("asset_field_definitions").select("field_key").eq("active", true).order("sort_order"),
      supabase.from("property_stakeholders").select("property_id").eq("user_id", user.id),
    ]);

  // Properties are READABLE org-wide but assets are WRITABLE only on the ones an
  // FM/PM is staked to. Offer only what the caller can actually write to, so the
  // preview can never validate a row the insert would then refuse.
  const writable =
    me.role === "admin"
      ? null // admin may write anywhere in the org
      : new Set((stakeRes.data ?? []).map((s) => s.property_id));

  const allowedProps = (propsRes.data ?? []).filter(
    (p) => writable === null || writable.has(p.id)
  );
  const allowedIds = new Set(allowedProps.map((p) => p.id));

  const properties = allowedProps.map(
    (p) => [p.name.toLowerCase(), p.id] as [string, string]
  );
  // Only units of writable properties, for the same reason.
  const units = (unitsRes.data ?? [])
    .filter((u) => allowedIds.has(u.property_id))
    .map((u) => [`${u.property_id}::${u.label.toLowerCase()}`, u.id] as [string, string]);
  const vendors = (vendorsRes.data ?? []).map(
    (v) => [v.name.toLowerCase(), v.id] as [string, string]
  );
  const users = (usersRes.data ?? [])
    .filter((u) => u.email)
    .map((u) => [u.email!.toLowerCase(), u.id] as [string, string]);
  const existingTags = (assetsRes.data ?? []).map((a) => a.asset_tag.toLowerCase());
  const customFieldKeys = (defsRes.data ?? []).map((d) => d.field_key);

  return {
    ctx: { properties, units, vendors, users, existingTags, customFieldKeys },
    propertyNames: allowedProps.map((p) => p.name),
  };
}

function toImportContext(raw: Awaited<ReturnType<typeof buildImportContext>>["ctx"]): ImportContext {
  return {
    propertiesByName: new Map(raw.properties),
    unitsByKey: new Map(raw.units),
    vendorsByName: new Map(raw.vendors),
    usersByEmail: new Map(raw.users),
    existingTags: new Set(raw.existingTags),
    customFieldKeys: raw.customFieldKeys,
  };
}

/**
 * Commits a validated CSV. Re-reads the lookup context and re-runs the SAME
 * validator server-side rather than trusting the browser's preview — the client
 * could have been tampered with, and tags may have been taken since the preview.
 * Returns per-row outcomes so the UI can report exactly what happened.
 */
export async function commitAssetImport(csvText: string): Promise<{
  inserted: number;
  failed: { rowNumber: number; reason: string }[];
}> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me) throw new Error("Could not resolve your profile.");
  if (!["admin", "facility_manager"].includes(me.role)) {
    throw new Error("Only an administrator or the managing FM/PM may import assets.");
  }

  const { ctx: rawCtx } = await buildImportContext();
  const { rows } = validateAssetCsv(csvText, toImportContext(rawCtx));

  const valid = rows.filter((r) => r.valid);
  const failed = rows
    .filter((r) => !r.valid)
    .map((r) => ({
      rowNumber: r.rowNumber,
      reason: r.issues.map((i) => `${i.column}: ${i.message}`).join("; "),
    }));

  if (valid.length === 0) return { inserted: 0, failed };

  // Insert in batches so a large register doesn't hit statement limits. Each
  // batch is its own statement; RLS still vets every row.
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    const payload = slice.map((r) => ({
      ...r.values,
      org_id: me.org_id,
      created_by: user.id,
    }));
    const { data, error } = await supabase.from("assets").insert(payload).select("id");
    if (error) {
      // Report the batch honestly rather than claiming a partial success we
      // can't substantiate.
      for (const r of slice) {
        failed.push({ rowNumber: r.rowNumber, reason: error.message });
      }
      continue;
    }
    inserted += data?.length ?? 0;
  }

  revalidatePath("/dashboard/assets");
  return { inserted, failed };
}

/** Single-asset create from the in-app form. */
export async function createAsset(form: Record<string, string>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) throw new Error("Could not resolve your profile.");

  const row: Record<string, unknown> = { org_id: me.org_id, created_by: user.id };

  if (!form.property_id) throw new Error("Property is required.");
  row.property_id = form.property_id;
  if (form.unit_id) row.unit_id = form.unit_id;

  for (const f of ASSET_FIELDS) {
    if (["property_name", "unit_label", "vendor_name", "custodian_email"].includes(f.key)) continue;
    const v = form[f.key];
    if (v == null || v === "") continue;
    if (f.type === "number") {
      const n = Number(String(v).replace(/[,\s₦]/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${f.label} must be a positive number.`);
      row[f.key] = n;
    } else if (f.type === "boolean") {
      row[f.key] = v === "true" || v === "yes" || v === "on";
    } else {
      row[f.key] = v;
    }
  }
  if (form.assigned_vendor_id) row.assigned_vendor_id = form.assigned_vendor_id;
  if (form.custodian_user_id) row.custodian_user_id = form.custodian_user_id;

  const { data, error } = await supabase.from("assets").insert(row).select("id").single();
  if (error) {
    // Surface the real reason — a duplicate tag and an RLS refusal need
    // different fixes from the user.
    if (error.message.includes("assets_org_tag_uidx")) {
      throw new Error("That asset tag is already in use in your organisation.");
    }
    if (error.message.includes("row-level security")) {
      throw new Error("You can only add assets to properties you manage.");
    }
    throw new Error(error.message);
  }

  revalidatePath("/dashboard/assets");
  return data.id as string;
}

export async function archiveAsset(assetId: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_asset", { p_asset_id: assetId });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/assets");
}
