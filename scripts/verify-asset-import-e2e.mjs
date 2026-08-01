// End-to-end bulk import against the real dev database, as the real FM/PM user:
// builds the lookup context the same way the app does, validates a mixed file,
// inserts only the valid rows through RLS, and confirms what landed.
// Usage: node scripts/verify-asset-import-e2e.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { validateAssetCsv } from "../lib/asset-import.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL, SVCK, { auth: { persistSession: false } });
const fm = createClient(URL, ANON);
await fm.auth.signInWithPassword({ email: "oe-group-foundation-poc.facilitymanager@oegroup.test", password: "OEGroupDemo2026!" });
const { data: { user } } = await fm.auth.getUser();
const { data: me } = await fm.from("users").select("org_id, role").eq("id", user.id).single();

// Mirror the app's writableProperties(): staked only, since this user is an FM.
const [{ data: allProps }, { data: stakes }, { data: units }, { data: existing }] =
  await Promise.all([
    fm.from("properties").select("id, name").order("name"),
    fm.from("property_stakeholders").select("property_id").eq("user_id", user.id),
    fm.from("units").select("id, label, property_id"),
    fm.from("assets").select("asset_tag"),
  ]);
const staked = new Set(stakes.map((s) => s.property_id));
const writable = allProps.filter((p) => staked.has(p.id));
const unmanaged = allProps.find((p) => !staked.has(p.id));

const ctx = {
  propertiesByName: new Map(writable.map((p) => [p.name.toLowerCase(), p.id])),
  unitsByKey: new Map(
    units.filter((u) => staked.has(u.property_id))
         .map((u) => [`${u.property_id}::${u.label.toLowerCase()}`, u.id])
  ),
  vendorsByName: new Map(),
  usersByEmail: new Map([[user.email.toLowerCase(), user.id]]),
  existingTags: new Set(existing.map((a) => a.asset_tag.toLowerCase())),
  customFieldKeys: [],
};

console.log("Asset bulk import — end to end against the dev database\n");
console.log(`  FM writes to: ${writable.map((p) => p.name).join(", ")}`);
console.log(`  Not managed : ${unmanaged?.name ?? "(none)"}\n`);

const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const csv = [
  "asset_tag,name,category,property_name,criticality,condition,purchase_cost,custodian_email,compliance_required,certificate_expiry",
  `E2E-${stamp}-A,Split AC — Boardroom,hvac,${writable[0].name},medium,good,"1,250,000",${user.email},no,`,
  `E2E-${stamp}-B,Inverter 5kVA,power_generation,${writable[0].name},high,new,900000,,yes,2027-01-31`,
  // must be rejected: property the FM does not manage
  `E2E-${stamp}-C,Sump Pump,plumbing,${unmanaged?.name ?? "Nowhere"},low,good,,,,`,
  // must be rejected: duplicate of an asset already seeded
  `GEN-IKJ-001,Duplicate Generator,power_generation,${writable[0].name},critical,good,,,,`,
  // must be rejected: bad enum
  `E2E-${stamp}-D,Access Barrier,securty,${writable[0].name},medium,good,,,,`,
].join("\n");

const { rows } = validateAssetCsv(csv, ctx);
const valid = rows.filter((r) => r.valid);
const invalid = rows.filter((r) => !r.valid);

console.log("A. Validation splits the file correctly");
valid.length === 2 ? ok(`2 rows valid`) : bad(`expected 2 valid, got ${valid.length}`);
invalid.length === 3 ? ok(`3 rows blocked`) : bad(`expected 3 blocked, got ${invalid.length}`);
for (const r of invalid) console.log(`     row ${r.rowNumber}: ${r.issues.map(i => i.message).join("; ")}`);

console.log("\nB. Only the valid rows are written, through RLS");
const payload = valid.map((r) => ({ ...r.values, org_id: me.org_id, created_by: user.id }));
const { data: inserted, error } = await fm.from("assets").insert(payload).select("id, asset_tag");
if (error) bad(`insert failed — ${error.message}`);
else if (inserted.length === 2) ok(`inserted ${inserted.map((a) => a.asset_tag).join(", ")}`);
else bad(`expected 2 inserts, got ${inserted.length}`);

console.log("\nC. The rejected rows really are absent");
for (const tag of [`E2E-${stamp}-C`, `E2E-${stamp}-D`]) {
  const { data } = await svc.from("assets").select("id").ilike("asset_tag", tag).maybeSingle();
  data ? bad(`${tag} was written despite being blocked`) : ok(`${tag} absent, as expected`);
}

console.log("\nD. Values survived the round trip");
{
  const { data } = await fm.from("assets")
    .select("asset_tag, purchase_cost, custodian_user_id, compliance_required, certificate_expiry, category")
    .ilike("asset_tag", `E2E-${stamp}-A`).single();
  data && Number(data.purchase_cost) === 1250000
    ? ok('"1,250,000" stored as 1250000')
    : bad(`purchase_cost is ${data?.purchase_cost}`);
  data?.custodian_user_id === user.id ? ok("custodian email resolved to the user") : bad("custodian not set");
  const { data: b } = await fm.from("assets")
    .select("compliance_required, certificate_expiry")
    .ilike("asset_tag", `E2E-${stamp}-B`).single();
  b?.compliance_required === true ? ok('"yes" stored as boolean true') : bad("compliance_required wrong");
  b?.certificate_expiry === "2027-01-31" ? ok("certificate expiry stored") : bad(`expiry is ${b?.certificate_expiry}`);
}

console.log("\nE. The import is auditable");
{
  const { count } = await svc.from("audit_log")
    .select("*", { count: "exact", head: true }).eq("action", "asset.write");
  count > 0 ? ok(`${count} asset.write audit entries`) : bad("no audit entries");
}

// Clean up everything this run created.
await svc.from("assets").delete().ilike("asset_tag", `E2E-${stamp}-%`);
console.log("\n(removed the E2E test assets)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — import writes only what validation approved."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
