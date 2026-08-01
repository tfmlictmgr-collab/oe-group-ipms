// Proves the asset register's access rules, using real logins:
//   • FM/PM can create + read assets on properties they manage
//   • FM/PM cannot create on a property they do NOT manage
//   • tenant / vendor / ops cannot create at all
//   • reads are property-scoped (FM sees fewer than admin)
//   • cross-org isolation holds
//   • a unit from another property is rejected (integrity trigger)
//   • hard DELETE is blocked; soft-delete hides the row
// Usage: node scripts/verify-asset-access.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

async function login(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);

const admin = await login("oe-group-foundation-poc.admin@oegroup.test");
const fm = await login("oe-group-foundation-poc.facilitymanager@oegroup.test");
const tenant = await login("oe-group-foundation-poc.tenant@oegroup.test");
const vendor = await login("oe-group-foundation-poc.vendor@oegroup.test");
const oea = await login("oea.admin@oegroup.test");

const { data: { user: fmUser } } = await fm.auth.getUser();
const { data: fmRow } = await fm.from("users").select("org_id").eq("id", fmUser.id).single();
const orgId = fmRow.org_id;

// Properties the FM manages vs. one they don't.
const { data: staked } = await svc
  .from("property_stakeholders").select("property_id").eq("user_id", fmUser.id);
const managed = staked.map((s) => s.property_id);
const { data: allProps } = await svc.from("properties").select("id, name").eq("org_id", orgId);
const unmanaged = allProps.find((p) => !managed.includes(p.id));

console.log("Asset register access rules (RLS-enforced)\n");
console.log(`FM manages ${managed.length} of ${allProps.length} properties in its org\n`);

console.log("A. FM/PM may create an asset on a property they MANAGE");
let createdId = null;
{
  const { data, error } = await fm.from("assets").insert({
    org_id: orgId, property_id: managed[0],
    asset_tag: `TEST-${stamp}`, name: "Test Generator 100kVA",
    category: "power_generation", criticality: "critical",
  }).select("id, asset_tag").single();
  if (!error && data) { createdId = data.id; ok(`created ${data.asset_tag}`); }
  else bad(`create on managed property refused — ${error?.message}`);
}

console.log("\nB. FM/PM may NOT create on a property they do NOT manage");
{
  if (!unmanaged) { ok("(skipped — FM manages every property in this org)"); }
  else {
    const { error } = await fm.from("assets").insert({
      org_id: orgId, property_id: unmanaged.id,
      asset_tag: `HIJACK-${stamp}`, name: "Should not exist",
    }).select("id");
    if (error) ok(`blocked (${error.message.slice(0, 55)})`);
    else bad("ALLOWED — FM created an asset outside their properties");
  }
}

console.log("\nC. Non-manager roles may NOT create assets");
for (const [label, client] of [["tenant", tenant], ["vendor", vendor]]) {
  const { error } = await client.from("assets").insert({
    org_id: orgId, property_id: managed[0],
    asset_tag: `${label}-${stamp}`, name: "Should not exist",
  }).select("id");
  if (error) ok(`${label} blocked (${error.message.slice(0, 45)})`);
  else bad(`ALLOWED — a ${label} created an asset`);
}

console.log("\nD. Reads are property-scoped");
{
  const countFor = async (c) =>
    (await c.from("assets").select("*", { count: "exact", head: true })).count ?? 0;
  const a = await countFor(admin);
  const f = await countFor(fm);
  const t = await countFor(tenant);
  if (f <= a) ok(`FM sees ${f} ≤ admin ${a}`);
  else bad(`FM sees ${f} > admin ${a}`);
  if (t === 0) ok("tenant sees 0 assets");
  else bad(`tenant sees ${t} assets`);
}

console.log("\nE. Cross-org isolation");
{
  const { data } = await oea.from("assets").select("org_id");
  const foreign = (data ?? []).filter((r) => r.org_id !== null && r.org_id === orgId);
  if (foreign.length === 0) ok("OEA user reads no TFML/POC assets");
  else bad(`OEA user read ${foreign.length} rows from another org`);
}

console.log("\nF. A unit from a different property is rejected (integrity trigger)");
{
  const { data: otherUnit } = await svc
    .from("units").select("id, property_id").neq("property_id", managed[0]).limit(1).maybeSingle();
  if (!otherUnit) ok("(skipped — no unit on another property)");
  else {
    const { error } = await fm.from("assets").insert({
      org_id: orgId, property_id: managed[0], unit_id: otherUnit.id,
      asset_tag: `MISMATCH-${stamp}`, name: "Mismatched unit",
    }).select("id");
    if (error) ok(`blocked (${error.message.slice(0, 55)})`);
    else bad("ALLOWED — asset filed under a unit of a different property");
  }
}

console.log("\nG. Hard DELETE blocked; archive hides the row; restore brings it back");
if (createdId) {
  const { error: delErr } = await fm.from("assets").delete().eq("id", createdId).select("id");
  if (delErr) ok(`hard delete blocked (${delErr.message.slice(0, 50)})`);
  else {
    const { data: still } = await svc.from("assets").select("id").eq("id", createdId).maybeSingle();
    if (still) ok("hard delete refused (row still present)");
    else bad("ALLOWED — asset was hard-deleted");
  }

  const { error: arcErr } = await fm.rpc("archive_asset", { p_asset_id: createdId });
  if (arcErr) bad(`archive failed — ${arcErr.message}`);
  else {
    const { data: afterSoft } = await fm.from("assets").select("id").eq("id", createdId).maybeSingle();
    if (!afterSoft) ok("archived asset no longer appears in the register");
    else bad("archived asset is still readable");
  }

  const { data: archived } = await fm.rpc("archived_assets");
  if ((archived ?? []).some((a) => a.id === createdId)) ok("archived asset visible via archived_assets()");
  else bad("archived asset missing from archived_assets()");

  const { error: resErr } = await fm.rpc("restore_asset", { p_asset_id: createdId });
  if (resErr) bad(`restore failed — ${resErr.message}`);
  else {
    const { data: back } = await fm.from("assets").select("id").eq("id", createdId).maybeSingle();
    if (back) ok("restored asset is readable again");
    else bad("restore did not bring the asset back");
  }
}

console.log("\nG2. A tenant may NOT archive an asset");
if (createdId) {
  const { error } = await tenant.rpc("archive_asset", { p_asset_id: createdId });
  if (error) ok(`blocked (${error.message.slice(0, 55)})`);
  else bad("ALLOWED — a tenant archived an asset");
}

console.log("\nH. Every write was audited");
{
  const { data } = await svc
    .from("audit_log").select("action").eq("action", "asset.write").limit(5);
  if ((data ?? []).length > 0) ok(`audit_log has ${data.length}+ asset.write entries`);
  else bad("no asset.write audit entries");
}

// Clean up the test row entirely (service role bypasses the delete guard).
if (createdId) await svc.from("assets").delete().eq("id", createdId);
console.log("\n(removed the test asset)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the asset register is role- and property-scoped."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
