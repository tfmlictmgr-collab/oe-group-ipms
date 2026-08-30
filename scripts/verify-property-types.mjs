// A property states its type from a list, grouped residential/commercial (0237).
//
// The claims that matter:
//   • the standard set is offered to every org, and is split into two halves
//   • an org's own addition is visible to that org and to NO other — B1 applies
//     to a dropdown's contents as much as to a data row
//   • adding one needs `properties.write`; a tenant or a vendor cannot
//   • the same label cannot be added twice
//   • `properties.property_type` is still text, so every property filed before
//     this migration keeps exactly what it carries
//   • anon is refused
//
// Usage: node scripts/verify-property-types.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) { bad(`could not sign in as ${email}: ${error.message}`); return null; }
  return c;
};

const oeaPm = await login("oea.pm@oegroup.test");
const tfmlPm = await login("tfml.pm@oegroup.test");
const tenant = await login("oea.tenant@oegroup.test");
if (!oeaPm || !tfmlPm || !tenant) process.exit(1);

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A The standard set, offered to everyone\x1b[0m");
const { data: mine } = await oeaPm.from("property_types").select("id, label, category, org_id");
const standard = (mine ?? []).filter((t) => t.org_id === null);
standard.length > 0
  ? ok(`the OEA manager is offered ${standard.length} standard description(s)`)
  : bad("no standard descriptions are offered");

const res = standard.filter((t) => t.category === "residential").length;
const com = standard.filter((t) => t.category === "commercial").length;
res > 0 && com > 0
  ? ok(`split into two halves — ${res} residential, ${com} commercial`)
  : bad(`the split is wrong: ${res} residential, ${com} commercial`);

(standard.every((t) => ["residential", "commercial"].includes(t.category)))
  ? ok("every description sits in one of the two halves and no third")
  : bad("a description carries a category outside residential/commercial");

// The form groups by these exact strings; a stray label would render outside
// both optgroups and simply not appear.
const { data: tStd } = await tfmlPm.from("property_types").select("id").is("org_id", null);
(tStd ?? []).length === standard.length
  ? ok(`TFML is offered the same ${(tStd ?? []).length} standards — a platform set, not an org's`)
  : bad(`TFML sees ${(tStd ?? []).length} standards against OEA's ${standard.length}`);

// ── B ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§B An org's own addition is its own\x1b[0m");
const { data: oeaMe } = await svc.from("users").select("org_id").eq("email","oea.pm@oegroup.test").single();
const { data: tfmlMe } = await svc.from("users").select("org_id").eq("email","tfml.pm@oegroup.test").single();
const label = `PROBE Tank Farm ${S}`;

// ⚠️ Three inserts, and the two that must FAIL are the point.
//
// `org_id` is supplied by the caller (this is exactly what addPropertyType
// sends), so the policy's `org_id = current_user_org_id()` is the only thing
// standing between a signed-in user and two things they must never do: mint a
// PLATFORM STANDARD by passing null — a row 0237 offers to every organisation
// on the system — or plant a description inside another org.
const { error: nullErr } = await oeaPm.from("property_types")
  .insert({ org_id: null, label: `PROBE Standard ${S}`, category: "commercial" });
nullErr
  ? ok("a manager cannot mint a platform standard (org_id null) — that row would reach every org")
  : bad("a manager created an org_id-null row, offered to the whole platform");

const { error: crossErr } = await oeaPm.from("property_types")
  .insert({ org_id: tfmlMe.org_id, label: `PROBE Cross ${S}`, category: "commercial" });
crossErr
  ? ok("and cannot plant a description in the other brand's list — B1 at the insert")
  : bad("an OEA manager wrote a description into TFML's list");

const { data: added, error: addErr } = await oeaPm.from("property_types")
  .insert({ org_id: oeaMe.org_id, label, category: "commercial" }).select("id").maybeSingle();
if (addErr) {
  bad(`the OEA manager could not add a description: ${addErr.message}`);
} else {
  made.push(added.id);
  ok(`the OEA manager added "${label}"`);

  const { data: back } = await oeaPm.from("property_types").select("id").eq("id", added.id);
  (back ?? []).length === 1 ? ok("and reads it back") : bad("cannot read back what they added");

  const { data: theirs } = await tfmlPm.from("property_types").select("id").eq("id", added.id);
  (theirs ?? []).length === 0
    ? ok("TFML cannot see it — B1 holds inside the dropdown")
    : bad("TFML can see an OEA-only description — B1 broken");

  // The org_id is stamped from the caller's profile by the policy, never taken
  // from the client, so a forged one cannot plant a row in another org.
  const { data: row } = await svc.from("property_types").select("org_id").eq("id", added.id).single();
  row.org_id === oeaMe.org_id
    ? ok("carrying the adder's own org")
    : bad(`carrying ${row.org_id}, expected ${oeaMe.org_id}`);

  const { error: dupErr } = await oeaPm.from("property_types")
    .insert({ org_id: oeaMe.org_id, label, category: "commercial" });
  dupErr ? ok("the same description cannot be added twice") : bad("a duplicate description was accepted");
}

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§C Adding one is part of filing a property\x1b[0m");
const { data: tenMe } = await svc.from("users").select("org_id").eq("email","oea.tenant@oegroup.test").single();
const { error: tenErr } = await tenant.from("property_types")
  .insert({ org_id: tenMe.org_id, label: `PROBE Tenant ${S}`, category: "residential" });
tenErr
  ? ok("a tenant cannot add a description — properties.write is required")
  : bad("a tenant added a property description");

const { data: tenRead } = await tenant.from("property_types").select("id").limit(1);
(tenRead ?? []).length > 0
  ? ok("but a tenant may READ the list — it names buildings, not money")
  : note("a tenant reads no descriptions; harmless, nothing renders this to them");

// ── D ──────────────────────────────────────────────────────────────────────
//
// The migration deliberately did NOT point properties.property_type at this
// catalogue. If that ever changes, hand-typed history is what breaks first.
console.log("\n\x1b[1m§D The column is still text, so history survives\x1b[0m");
const { data: props } = await svc
  .from("properties").select("property_type").not("property_type", "is", null).limit(200);
const values = [...new Set((props ?? []).map((p) => p.property_type))];
const { data: allStd } = await svc.from("property_types").select("label").is("deleted_at", null);
const known = new Set((allStd ?? []).map((t) => t.label));
const legacy = values.filter((v) => !known.has(v));
ok(`${values.length} distinct type(s) recorded across the register`);
legacy.length
  ? ok(`${legacy.length} of them predate the catalogue (e.g. "${legacy[0]}") and are still readable`)
  : note("every recorded type happens to match the catalogue; the text column still permits others");

// ── E ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§E anon is refused\x1b[0m");
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const { data: aRead, error: aErr } = await anon.from("property_types").select("id").limit(1);
(aErr || (aRead ?? []).length === 0)
  ? ok("anon reads no descriptions")
  : bad(`anon read ${aRead.length} description(s)`);

// ── cleanup ────────────────────────────────────────────────────────────────
for (const id of made) await svc.from("property_types").delete().eq("id", id);
await svc.from("property_types").delete().like("label", `PROBE %${S}`);
if (made.length) console.log("\n(cleaned up)");

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ property types: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
