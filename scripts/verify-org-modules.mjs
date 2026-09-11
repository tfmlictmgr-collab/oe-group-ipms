// Every organisation states every module, and an org created outside the
// provisioning function is no exception.
//
// The claims that matter:
//   • no live org is SILENT about a module — a missing row and a `false` row
//     are different facts, and only one of them is a decision (0192)
//   • an OEA-branded org gets lettings ON, so a property-management firm is
//     never told it "has no leases to administer" on its own portal
//   • a TFML/direct org gets lettings OFF — the flag follows the brand, and
//     this fix must not have opened lettings for everyone to close the bug
//   • ai_document_checks defaults OFF for every org (decision 10: "a per-org
//     B9 flag, off by default")
//   • the trigger fires on a RAW insert into `orgs` — not merely inside
//     operator_provision_org — because going around that function is exactly
//     how staging's OEA ended up with no rows at all
//   • re-seeding never overwrites a STATED flag: an org whose module was
//     deliberately switched on/off keeps its value
//
// Usage: node scripts/verify-org-modules.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const S = Date.now().toString(36).toUpperCase().slice(-5);

// A probe org cannot be hard-deleted once anything references it (0114), and
// the trigger under test writes org_modules rows immediately — so these are
// retired, exactly as verify-org-creation.mjs does, never removed.
async function retireProbeOrgs() {
  const { data } = await svc
    .from("orgs").select("id").like("name", "PROBEMOD-%").is("deleted_at", null);
  for (const o of data ?? []) {
    await svc.from("orgs").update({ deleted_at: new Date().toISOString() }).eq("id", o.id);
  }
}
await retireProbeOrgs();

console.log("Org modules: a contracted capability is stated, never merely absent\n");

// ── A. No live org is silent ───────────────────────────────────────────────
console.log("A. Every live organisation states every module");
const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, name, delivery_brand").is("deleted_at", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }

const { data: allMods, error: modErr } = await svc
  .from("org_modules").select("org_id, module, enabled");
if (modErr) { console.error("org_modules unreadable:", modErr.message); process.exit(1); }

const modsFor = (orgId) =>
  Object.fromEntries(
    allMods.filter((m) => m.org_id === orgId).map((m) => [m.module, m.enabled])
  );

const MODULES = ["lettings", "ai_document_checks"];
const silent = [];
for (const o of orgs) {
  const m = modsFor(o.id);
  for (const mod of MODULES) if (!(mod in m)) silent.push(`${o.name} · ${mod}`);
}
silent.length === 0
  ? ok(`all ${orgs.length} live orgs state all ${MODULES.length} modules`)
  : bad(`SILENT about a module: ${silent.join(", ")}`);

// ── B. The flag follows the brand ──────────────────────────────────────────
console.log("\nB. Lettings follows the delivery brand, both ways");
{
  const oea = orgs.filter((o) => o.delivery_brand === "OEA");
  const other = orgs.filter((o) => o.delivery_brand !== "OEA");

  if (oea.length === 0) {
    // Not a pass and not a failure of the code — say so rather than counting
    // a check that never ran as evidence.
    console.log("  \x1b[33mSKIP\x1b[0m no OEA-branded org in this world to check");
  } else {
    const wrong = oea.filter((o) => modsFor(o.id).lettings !== true);
    wrong.length === 0
      ? ok(`all ${oea.length} OEA org(s) have lettings enabled — the defect 0192 closed`)
      : bad(`AN OEA ORG HAS LETTINGS OFF: ${wrong.map((o) => o.name).join(", ")}`);
  }

  // The other half of the same claim: closing the bug must not have switched
  // lettings on for a facilities org, which genuinely has no leases.
  const wronglyOn = other.filter((o) => modsFor(o.id).lettings === true);
  wronglyOn.length === 0
    ? ok(`no non-OEA org had lettings switched on (${other.length} checked)`)
    : bad(`LETTINGS ON FOR A NON-OEA ORG: ${wronglyOn.map((o) => o.name).join(", ")}`);
}

// ── C. org_has_module() agrees with the row ────────────────────────────────
// The screens read the function, not the table. If these ever disagree, the
// table is right and the portal is still wrong.
console.log("\nC. The resolver every screen calls agrees with the stored row");
{
  let mismatches = 0;
  for (const o of orgs) {
    const { data: rpc } = await svc.rpc("org_has_module", {
      p_org_id: o.id, p_module: "lettings",
    });
    if (rpc !== (modsFor(o.id).lettings === true)) mismatches++;
  }
  mismatches === 0
    ? ok("org_has_module('lettings') matches org_modules for every org")
    : bad(`${mismatches} org(s) where the resolver and the table disagree`);
}

// ── D. The trigger fires on a raw insert ───────────────────────────────────
// This is the claim that actually stops the bug recurring. operator_provision_org
// has always seeded modules; the orgs that broke were inserted around it.
console.log("\nD. An org inserted directly still states its modules");
const probeOrgIds = {};
for (const brand of ["OEA", "TFML"]) {
  const { data: made, error } = await svc
    .from("orgs")
    .insert({ name: `PROBEMOD-${brand}-${S}`, delivery_brand: brand, slug: `probemod-${brand.toLowerCase()}-${S.toLowerCase()}` })
    .select("id").single();

  if (error) { bad(`could not insert a ${brand} probe org: ${error.message}`); continue; }
  probeOrgIds[brand] = made.id;

  const { data: mods } = await svc
    .from("org_modules").select("module, enabled").eq("org_id", made.id);
  const m = Object.fromEntries((mods ?? []).map((x) => [x.module, x.enabled]));

  MODULES.every((mod) => mod in m)
    ? ok(`a raw ${brand} insert got all ${MODULES.length} module rows without going through operator_provision_org`)
    : bad(`A RAW ${brand} INSERT GOT NO MODULE ROWS — the trigger did not fire`);

  m.lettings === (brand === "OEA")
    ? ok(`  …and lettings came out ${brand === "OEA" ? "ON" : "OFF"}, from its brand`)
    : bad(`  …but lettings is ${m.lettings} for a ${brand} org`);

  m.ai_document_checks === false
    ? ok("  …and ai_document_checks defaulted OFF (decision 10)")
    : bad(`  …but ai_document_checks defaulted to ${m.ai_document_checks}`);

}

// ── E. A stated flag survives re-seeding ───────────────────────────────────
// The backfill in 0192 runs `seed_org_modules` over every org. If it
// overwrote, an operator's deliberate switch would silently revert on the next
// migration that calls it.
console.log("\nE. Re-seeding never overwrites a stated flag");
if (!probeOrgIds.OEA) {
  bad("no probe org survived section D to re-seed");
} else {
  await svc.from("org_modules")
    .update({ enabled: true }).eq("org_id", probeOrgIds.OEA).eq("module", "ai_document_checks");

  const { error: reseedErr } = await svc.rpc("seed_org_modules", { p_org_id: probeOrgIds.OEA });

  if (reseedErr) {
    // Not silently swallowed: if the suite cannot exercise the real function
    // it says so rather than reporting a check it never ran.
    bad(`could not call seed_org_modules to re-seed: ${reseedErr.message}`);
  } else {
    const { data: after } = await svc
      .from("org_modules").select("enabled")
      .eq("org_id", probeOrgIds.OEA).eq("module", "ai_document_checks").single();

    after?.enabled === true
      ? ok("a deliberately-enabled module stayed enabled through a re-seed")
      : bad("A RE-SEED RESET A DELIBERATELY-ENABLED MODULE TO ITS DEFAULT");
  }
}

await retireProbeOrgs();
console.log("\n(cleaned up)\n");

if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — every org states its modules, and the brand decides lettings.");
