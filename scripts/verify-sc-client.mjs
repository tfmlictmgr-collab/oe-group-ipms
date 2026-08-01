// The service-charge client exists, is independent, is associated to BOTH brands
// — and the association grants nobody anything.
//
// The last assertion is the one worth running. `org_brand_associations` is
// descriptive by design (0094), and "descriptive" is a property that decays
// silently: the day a policy joins to it for convenience, the table becomes the
// second crossing of org isolation and nothing about the call site looks wrong.
// So this suite asserts the negative directly — a TFML administrator must not be
// able to reach the client's rows, nor enumerate the client at all.
//
// Usage: node scripts/verify-sc-client.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};

async function login(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

console.log("\nService-charge client — independent, associated to both, granting nothing\n");

// ── A. The organisation ───────────────────────────────────────────────────
console.log("A. The client is an organisation in its own right");

const { data: org } = await svc
  .from("orgs")
  .select("id, name, slug, delivery_brand, parent_org_id, is_platform_operator, deleted_at")
  .eq("slug", "sc-client")
  .is("deleted_at", null)
  .maybeSingle();

ok("the service-charge client org exists", !!org);
if (!org) {
  console.log("\nCannot continue without the org — run node scripts/migrate.mjs");
  process.exit(1);
}

ok("it is fully independent (no parent org)", org.parent_org_id === null,
  `parent_org_id = ${org.parent_org_id}`);
ok("no single brand owns it (delivery_brand = direct)", org.delivery_brand === "direct",
  `got ${org.delivery_brand}`);
ok("it is not the platform operator", org.is_platform_operator === false);
ok("it has its own front door (/o/sc-client)", org.slug === "sc-client");

// ── B. Associated to both brands ──────────────────────────────────────────
console.log("\nB. Associated to BOTH brands, in stated capacities");

const { data: assoc } = await svc
  .from("org_brand_associations")
  .select("brand, engagement")
  .eq("org_id", org.id)
  .order("brand");

const byBrand = Object.fromEntries((assoc ?? []).map((a) => [a.brand, a.engagement]));
ok("TFML is associated", "TFML" in byBrand);
ok("TFML's capacity is service charge management",
  byBrand.TFML === "service charge management", `got "${byBrand.TFML}"`);
ok("OEA is associated", "OEA" in byBrand);
ok("OEA's capacity is service charge administration",
  byBrand.OEA === "service charge administration", `got "${byBrand.OEA}"`);
ok("exactly two associations, not a hierarchy", (assoc ?? []).length === 2,
  `got ${(assoc ?? []).length}`);

// ── C. The invariants the trigger exists to hold ──────────────────────────
console.log("\nC. Association is a delivery fact, not ownership");

{
  const { data: tfmlOrg } = await svc.from("orgs")
    .select("id").eq("slug", "tfml").is("deleted_at", null).maybeSingle();

  // A branded org is NESTED, not associated — that distinction is what keeps
  // "who owns this client" a question with one answer.
  const { error } = await svc.from("org_brand_associations")
    .insert({ org_id: tfmlOrg.id, brand: "OEA", engagement: "probe" });
  ok("a brand-delivered org cannot be given an association", !!error,
    error ? "" : "the insert SUCCEEDED");

  const { data: opOrg } = await svc.from("orgs")
    .select("id").eq("is_platform_operator", true).maybeSingle();
  const { error: opErr } = await svc.from("org_brand_associations")
    .insert({ org_id: opOrg.id, brand: "TFML", engagement: "probe" });
  ok("the platform operator cannot be a brand's client", !!opErr,
    opErr ? "" : "the insert SUCCEEDED");

  const { error: dirErr } = await svc.from("org_brand_associations")
    .insert({ org_id: org.id, brand: "direct", engagement: "probe" });
  ok("'direct' is not a brand you can associate", !!dirErr,
    dirErr ? "" : "the insert SUCCEEDED");

  const { error: dupErr } = await svc.from("org_brand_associations")
    .insert({ org_id: org.id, brand: "TFML", engagement: "service charge management" });
  ok("the same engagement cannot be recorded twice", !!dupErr,
    dupErr ? "" : "the insert SUCCEEDED");
}

// ── D. The association grants NOTHING ─────────────────────────────────────
//
// The point of the whole suite.
console.log("\nD. Being associated grants no sight of the client");

{
  const tfmlAdmin = await login("tfml.admin@oegroup.test");

  const { data: seenOrgs } = await tfmlAdmin.from("orgs").select("id, slug");
  ok("a TFML admin cannot see the client org row",
    !(seenOrgs ?? []).some((o) => o.id === org.id),
    `saw ${(seenOrgs ?? []).map((o) => o.slug).join(", ")}`);

  const { data: seenAssoc } = await tfmlAdmin.from("org_brand_associations").select("org_id, brand");
  ok("a TFML admin cannot enumerate who TFML serves",
    (seenAssoc ?? []).length === 0,
    `saw ${(seenAssoc ?? []).length} association(s)`);

  const { data: seenUsers } = await tfmlAdmin.from("users").select("id").eq("org_id", org.id);
  ok("a TFML admin cannot read the client's people", (seenUsers ?? []).length === 0,
    `saw ${(seenUsers ?? []).length}`);

  // ⚠️ These four only mean something once the client HOLDS data. While the org
  // was an empty shell every "cannot see" assertion passed for the wrong reason —
  // there was nothing to see. Seeded via scripts/seed-sc-client.mjs; if the seed
  // has not been run these degrade to the same vacuous pass, so the count of what
  // exists is asserted first.
  const { count: realProps } = await svc.from("properties")
    .select("*", { count: "exact", head: true }).eq("org_id", org.id);
  ok("the client actually holds data, so the checks below are not vacuous",
    (realProps ?? 0) > 0, "run node scripts/seed-sc-client.mjs");

  if ((realProps ?? 0) > 0) {
    for (const [table, label] of [
      ["properties", "properties"], ["vendors", "vendors"],
      ["payments", "vendor payments"], ["sc_budgets", "service-charge budgets"],
    ]) {
      const { data: rows } = await tfmlAdmin.from(table).select("id").eq("org_id", org.id);
      ok(`a TFML admin cannot read the client's ${label}`, (rows ?? []).length === 0,
        `saw ${(rows ?? []).length}`);
    }
  }

  const { error: writeErr } = await tfmlAdmin.from("org_brand_associations")
    .insert({ org_id: org.id, brand: "TFML", engagement: "self-granted" });
  ok("a brand admin cannot write itself an association", !!writeErr,
    writeErr ? "" : "the insert SUCCEEDED");

  await tfmlAdmin.auth.signOut();
}

// ── E. The client's own people see their own arrangement ──────────────────
console.log("\nE. The client can see who serves it");

{
  const { data: scAdminRow } = await svc.from("users")
    .select("email").eq("org_id", org.id).eq("role", "admin")
    .is("deactivated_at", null).limit(1).maybeSingle();

  if (!scAdminRow) {
    ok("a client administrator exists", false, "run node scripts/seed-org-logins.mjs");
  } else {
    const scAdmin = await login(scAdminRow.email);
    const { data: own } = await scAdmin.from("org_brand_associations")
      .select("brand, engagement").order("brand");
    ok("the client sees both of its delivery brands", (own ?? []).length === 2,
      `saw ${(own ?? []).length}`);
    ok("and reads them as the stated engagements",
      (own ?? []).some((a) => a.brand === "TFML" && a.engagement === "service charge management") &&
      (own ?? []).some((a) => a.brand === "OEA" && a.engagement === "service charge administration"));

    const { data: crossOrg } = await scAdmin.from("orgs").select("id, slug");
    ok("but still sees no other organisation",
      (crossOrg ?? []).every((o) => o.id === org.id),
      `saw ${(crossOrg ?? []).map((o) => o.slug).join(", ")}`);
    await scAdmin.auth.signOut();
  }
}

// ── F. It arrived with somewhere to file a property ───────────────────────
//
// 0087 seeded the geopolitical tree with a one-off backfill, so every org created
// afterwards got nothing. This client was the first to land on that side of the
// line, and `operator_provision_org` would have onboarded every future client the
// same way — a backfill only holds until the next INSERT (0097).
console.log("\nF. The client arrived with the standard hierarchy");

{
  const { data: nodes } = await svc
    .from("org_nodes").select("level, name")
    .eq("org_id", org.id).is("deleted_at", null);

  const regions = (nodes ?? []).filter((n) => n.level === "region");
  const locations = (nodes ?? []).filter((n) => n.level === "location");

  ok("the three regions exist", regions.length === 3, `got ${regions.length}`);
  ok("Nigeria's cities are seeded as locations", locations.length >= 25,
    `got ${locations.length}`);
  ok("Lagos is one of them", locations.some((l) => l.name === "Lagos"));
  ok("Port Harcourt is one of them", locations.some((l) => l.name === "Port Harcourt"));

  // Idempotence is the property the whole design rests on: an FM may already have
  // created "Lagos" by hand before anyone runs this.
  const { data: added, error: seedErr } = await svc
    .rpc("seed_org_hierarchy", { p_org_id: org.id });
  ok("re-seeding adds nothing", !seedErr && added === 0,
    seedErr ? seedErr.message : `added ${added}`);

  const { data: opOrg } = await svc.from("orgs")
    .select("id").eq("is_platform_operator", true).maybeSingle();
  const { data: opAdded } = await svc.rpc("seed_org_hierarchy", { p_org_id: opOrg.id });
  ok("the operator is never given a tree — it holds no client data", opAdded === 0,
    `added ${opAdded}`);
}

// ── G. Public entry surface ───────────────────────────────────────────────
console.log("\nG. Its own front door, which cannot be made to list");

{
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });

  const { data: branding } = await anon.rpc("org_public_branding", { p_slug: "sc-client" });
  ok("/o/sc-client resolves anonymously", (branding ?? []).length === 1);
  ok("and carries the client's own branding",
    branding?.[0]?.name === "Service Charge Client", `got "${branding?.[0]?.name}"`);

  const { data: wild } = await anon.rpc("org_public_branding", { p_slug: "%" });
  ok("a wildcard slug lists nothing", (wild ?? []).length === 0,
    `returned ${(wild ?? []).length} row(s)`);

  const { data: dir } = await anon.rpc("operator_org_directory");
  ok("anonymous callers get an empty directory, not a refusal", (dir ?? []).length === 0);
}

// ── Result ────────────────────────────────────────────────────────────────
console.log(
  failures.length === 0
    ? `\n\x1b[32mALL ${pass} CHECKS PASSED\x1b[0m — the client is independent, both brands are recorded, and neither can see it.\n`
    : `\n\x1b[31m${failures.length} FAILED\x1b[0m of ${pass + failures.length}:\n${failures.map((f) => `   ${f}`).join("\n")}\n`
);
process.exit(failures.length === 0 ? 0 : 1);
