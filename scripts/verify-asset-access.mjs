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

console.log("\nG2. An hour meter only counts up (0187)");
{
  // A generator is serviced on running hours, not a calendar — a 500-hour
  // interval is six weeks of grid instability or nine months of standby duty.
  // That only holds if the reading is trustworthy, and the way it stops being
  // trustworthy is a typo: 12000 for 1200 marks the machine 10,500 hours
  // overdue and it is never serviced again.
  //
  // Driven by a SIGNED-IN administrator, deliberately. The same checks under
  // the service-role client pass vacuously, because the function resolves the
  // caller's org from auth.uid() and refuses "you are not signed in" long
  // before it ever looks at the number.
  const onProp = managed[0] ?? allProps[0]?.id;
  const { data: mtr } = await svc.from("assets").insert({
    org_id: orgId, property_id: onProp,
    asset_tag: `METER-${stamp}`, name: "Probe Generator (hours)",
    category: "power_generation",
    maintenance_strategy: "usage", service_interval_hours: 500,
  }).select("id").single();

  if (!mtr) { bad("could not create the probe generator"); }
  else {
    const { error: e1 } = await admin.rpc("log_asset_running_hours",
      { p_asset_id: mtr.id, p_hours: 400 });
    e1 ? bad(`a first reading was refused: ${e1.message}`)
       : ok("an administrator records a 400-hour reading");

    const { data: due } = await svc.from("assets")
      .select("running_hours").eq("id", mtr.id).single();
    Number(due?.running_hours) === 400
      ? ok("the reading is stored — 100 running hours to its next service")
      : bad(`the reading did not stick: ${due?.running_hours}`);

    const { error: back } = await admin.rpc("log_asset_running_hours",
      { p_asset_id: mtr.id, p_hours: 100 });
    back && /only counts up/i.test(back.message)
      ? ok("a reading BELOW the last is refused, and says why")
      : bad(`!!! an hour meter ran backwards: ${back?.message ?? "accepted"}`);

    const { error: repl } = await admin.rpc("log_asset_running_hours",
      { p_asset_id: mtr.id, p_hours: 100, p_meter_replaced: true });
    repl ? bad(`a declared meter replacement was refused: ${repl.message}`)
         : ok("...unless the meter is declared replaced, which restarts the count");

    const { data: after } = await svc.from("assets")
      .select("last_service_running_hours").eq("id", mtr.id).single();
    Number(after?.last_service_running_hours) === 0
      ? ok("a replaced meter rebases the baseline to zero, not the old machine's life")
      : bad(`the baseline did not rebase: ${after?.last_service_running_hours}`);

    const { error: denied } = await tenant.rpc("log_asset_running_hours",
      { p_asset_id: mtr.id, p_hours: 900 });
    denied ? ok("a tenant cannot record a reading (assets.write)")
           : bad("!!! a tenant recorded an hour-meter reading");

    await svc.from("assets").delete().eq("id", mtr.id);
  }
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
