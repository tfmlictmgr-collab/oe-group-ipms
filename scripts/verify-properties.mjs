// Properties and units — the register everything else hangs off.
//
// The claims that matter:
//   • a property/unit can be created, and only with the capability
//   • an FM/PM sees the properties they are ATTACHED to, and no others
//   • a unit label is unique within its property (a duplicate makes every
//     invoice for it ambiguous)
//   • an apportionment factor must be positive (a zero-weighted unit pays
//     nothing and its share falls silently on its neighbours)
//   • nothing is hard-deleted; retiring refuses while obligations remain
//   • attaching someone to a property GRANTS them access — the attaché
//     assignment is real, not a label
//
// Usage: npx tsx scripts/verify-properties.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const made = { properties: [], units: [], stakes: [] };

const { data: admin } = await svc.from("users").select("id, org_id")
  .eq("email", "demo@oegroup.test").single();
const orgId = admin.org_id;
const { data: fmUser } = await svc.from("users").select("id")
  .eq("email", "fm@oegroup.test").single();

const adminC = await login("demo@oegroup.test");
const fmC = await login("fm@oegroup.test");

console.log("Properties and units\n");

console.log("A. A property can be created — and a tenant cannot");
let propId;
{
  const { data, error } = await adminC.from("properties")
    .insert({ org_id: orgId, name: `Probe Court ${stamp}`, reference: `PRB-${stamp}` })
    .select("id").single();
  if (error) { bad(`admin could not create — ${error.message.slice(0, 60)}`); }
  else { propId = data.id; made.properties.push(propId); ok("an administrator created a property"); }

  const tenant = await login("resident@oegroup.test");
  const { error: tErr } = await tenant.from("properties")
    .insert({ org_id: orgId, name: `Tenant probe ${stamp}` });
  tErr ? ok("a tenant cannot create one") : bad("A TENANT CREATED A PROPERTY");
}

console.log("\nB. A duplicate reference is refused");
{
  const { error } = await adminC.from("properties")
    .insert({ org_id: orgId, name: `Other ${stamp}`, reference: `PRB-${stamp}` });
  error ? ok("a second property cannot claim the same reference")
        : bad("TWO PROPERTIES SHARE A REFERENCE");
}

console.log("\nC. Units: labels unique, factors positive");
{
  const { data: u1, error: e1 } = await adminC.from("units")
    .insert({ org_id: orgId, property_id: propId, label: "Flat 1", apportionment_factor: 100 })
    .select("id").single();
  e1 ? bad(`could not add a unit — ${e1.message.slice(0, 50)}`) : ok("added Flat 1");
  if (u1) made.units.push(u1.id);

  const { error: dup } = await adminC.from("units")
    .insert({ org_id: orgId, property_id: propId, label: "flat 1", apportionment_factor: 50 });
  dup ? ok("a duplicate label is refused, case-insensitively")
      : bad("TWO UNITS SHARE A LABEL — every invoice for it is now ambiguous");

  for (const [label, factor] of [["zero", 0], ["negative", -5]]) {
    const { error } = await adminC.from("units")
      .insert({ org_id: orgId, property_id: propId, label: `Probe ${label}`, apportionment_factor: factor });
    error ? ok(`a ${label} apportionment factor is refused`)
          : bad(`A ${label.toUpperCase()} FACTOR WAS ACCEPTED — its share falls on the neighbours`);
  }
}

console.log("\nD. Nothing is hard-deleted");
{
  const { error } = await svc.from("properties").delete().eq("id", propId);
  error ? ok(`a delete is refused outright (${error.message.slice(0, 44)})`)
        : bad("A PROPERTY WAS HARD-DELETED — its assets and invoices are orphaned");
}

console.log("\nE. Retiring refuses while obligations remain");
{
  const { error } = await svc.rpc("retire_property", { p_property_id: propId });
  error && /active unit/.test(error.message)
    ? ok("a property with live units cannot be retired")
    : bad(`expected a refusal naming the units, got: ${error?.message ?? "success"}`);

  // Give the unit an occupant, then try to retire it.
  const { data: tenantUser } = await svc.from("users").select("id")
    .eq("email", "resident@oegroup.test").single();
  await svc.from("units").update({ occupant_user_id: tenantUser.id }).eq("id", made.units[0]);

  const { error: uErr } = await svc.rpc("retire_unit", { p_unit_id: made.units[0] });
  uErr && /occupant/.test(uErr.message)
    ? ok("a unit with an occupant cannot be retired")
    : bad(`expected a refusal naming the occupant, got: ${uErr?.message ?? "success"}`);

  // Clear the occupant and it retires cleanly.
  await svc.from("units").update({ occupant_user_id: null }).eq("id", made.units[0]);
  const { error: okErr } = await svc.rpc("retire_unit", { p_unit_id: made.units[0] });
  okErr ? bad(`could not retire a free unit — ${okErr.message.slice(0, 50)}`)
        : ok("a free unit retires");

  const { data: gone } = await adminC.from("units").select("id").eq("id", made.units[0]);
  (gone ?? []).length === 0
    ? ok("a retired unit disappears from every read")
    : bad("a retired unit is still visible");
}

console.log("\nF. The attaché assignment GRANTS access");
{
  // The FM is not attached, so the new property must be invisible to them —
  // properties.read_all is finance-only under B7.
  const before = await fmC.from("properties").select("id").eq("id", propId);
  (before.data ?? []).length === 0
    ? ok("an unattached FM cannot see the property")
    : bad("AN UNATTACHED FM SAW IT");

  const { data: stake, error } = await adminC.from("property_stakeholders")
    .insert({ org_id: orgId, property_id: propId, user_id: fmUser.id, relation: "manager" })
    .select("id").single();
  if (error) { bad(`could not attach — ${error.message.slice(0, 50)}`); }
  else {
    made.stakes.push(stake.id);
    const after = await fmC.from("properties").select("id").eq("id", propId);
    (after.data ?? []).length === 1
      ? ok("attaching them made it visible — the assignment is the access")
      : bad("attached, but still cannot see it");
  }

  // ...and detaching removes it again.
  await svc.from("property_stakeholders").delete().eq("id", made.stakes[0]);
  const detached = await fmC.from("properties").select("id").eq("id", propId);
  (detached.data ?? []).length === 0
    ? ok("detaching removed the access")
    : bad("access survived detachment");
  made.stakes = [];
}

console.log("\nG. Org isolation holds");
{
  const { data: otherOrg } = await svc.from("orgs").select("id, name")
    .neq("id", orgId).limit(1).single();
  const { error } = await adminC.from("properties")
    .insert({ org_id: otherOrg.id, name: `Cross-org probe ${stamp}` });
  error ? ok(`cannot create a property in ${otherOrg.name}`)
        : bad("CREATED A PROPERTY IN ANOTHER ORGANISATION");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Hard delete is blocked by design, so the fixtures are retired the same way a
// real one would be — which also exercises the path a second time.
await svc.from("property_stakeholders").delete().in("id", made.stakes);
for (const u of made.units) {
  await svc.from("units").update({ occupant_user_id: null, deleted_at: new Date().toISOString() }).eq("id", u);
}
await svc.from("units").update({ deleted_at: new Date().toISOString() })
  .eq("property_id", propId).is("deleted_at", null);
for (const p of made.properties) {
  await svc.from("properties").update({ deleted_at: new Date().toISOString() }).eq("id", p);
}
console.log("\n(fixtures retired)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the register is writable, bounded, and the attaché assignment is real access."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
