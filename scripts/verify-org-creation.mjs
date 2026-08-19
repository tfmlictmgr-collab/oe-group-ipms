// A new organisation gets a working front door, and only an operator may
// create one.
//
// The claims that matter:
//   • only an administrator OF the operator org may provision an org
//   • a brand administrator is refused, both via the RPC and via a direct
//     insert into `orgs` (RLS)
//   • the new org gets a slug, derived the way 0085 backfilled one — TFML and
//     OEA keep their pre-agreed addresses, everything else slugifies the name
//   • the slug is unique: two orgs sharing a name, or a second TFML/OEA-branded
//     org, get numbered suffixes instead of colliding
//   • provisioning is audited to operator_actions, carrying the slug it set
//   • the B7 permission baseline, the lettings flag and the geopolitical
//     hierarchy all land in the same call — this is not just a slug patch
//   • a reason that says nothing, a missing name, or a missing admin email
//     are all refused
//
// Identities are throwaway probe accounts created here with the service-role
// key (same shape as verify-operator-governance.mjs) rather than assumed
// fixture logins — this suite must pass against any environment, not only
// one seeded with specific named accounts.
//
// Usage: node scripts/verify-org-creation.mjs
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
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeOrgIds = [];
const madeUserIds = [];

// A provisioned org can never be deleted (0114/verify-operator-governance) —
// `operator_actions` and `audit_log` reference it and the trail is append-only.
// So the marker is retired at the end, not removed, and any straggler from a
// previous crashed run is retired here too, before it can shadow this run's
// slug-collision checks.
async function retireProbeOrgs() {
  const { data } = await svc
    .from("orgs").select("id").like("name", "PROBEORG-%").is("deleted_at", null);
  for (const o of data ?? []) {
    await svc.from("orgs").update({ deleted_at: new Date().toISOString() }).eq("id", o.id);
  }
}
async function cleanupStaleProbeUsers() {
  const { data } = await svc.from("users").select("id").like("email", "probeorg.%@oegroup.test");
  for (const u of data ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
}
await retireProbeOrgs();
await cleanupStaleProbeUsers();

const orgRes = await svc
  .from("orgs").select("id, slug, name, delivery_brand, is_platform_operator").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }

const flaggedOperator = orgRes.data.find((o) => o.is_platform_operator);
// If nothing is flagged as the operator yet, borrow the platform's own POC/
// foundation org for the duration of this run, the way
// verify-operator-governance.mjs does — restored before exit either way.
const operatorOrg = flaggedOperator ?? orgRes.data.find((o) => o.delivery_brand === "direct");
if (!operatorOrg) {
  console.error("No organisation to use as the operator, and none is flagged is_platform_operator.");
  process.exit(1);
}
const wasOperator = !!flaggedOperator;
if (!wasOperator) {
  await svc.from("orgs").update({ is_platform_operator: true }).eq("id", operatorOrg.id);
}
const brandOrg = orgRes.data.find((o) => o.id !== operatorOrg.id);
if (!brandOrg) {
  console.error("No second organisation to use as a non-operator brand admin.");
  process.exit(1);
}

async function makeUser(orgId, role, tag) {
  const email = `probeorg.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: orgId, email, full_name: `Probe ${tag}`, role,
  });
  madeUserIds.push(created.user.id);
  return { id: created.user.id, email };
}

console.log("Org creation: a working address for every organisation, operator-only\n");

const opAdmin = await makeUser(operatorOrg.id, "admin", "opadmin");
const brandAdmin = await makeUser(brandOrg.id, "admin", "brandadmin");

console.log("A. Only an administrator OF the operator org may provision one");
{
  const brand = await login(brandAdmin.email);
  const { error } = await brand.rpc("operator_provision_org", {
    p_name: `PROBEORG-Refused-${S}`, p_delivery_brand: "direct",
    p_admin_email: `probeorg.refused.${S}@example.com`, p_admin_name: "Refused",
    p_reason: "a brand administrator attempting to provision an org",
    p_token_hash: "x".repeat(16),
  });
  error ? ok("a brand administrator cannot provision an org via the RPC")
        : bad("A BRAND ADMIN PROVISIONED AN ORGANISATION");

  // Nor by writing the table directly — RLS, not just the definer function.
  const { data: patched } = await brand
    .from("orgs").insert({ name: `PROBEORG-Direct-${S}`, delivery_brand: "direct" }).select("id");
  (patched ?? []).length === 0
    ? ok("nor insert into orgs directly")
    : bad("A BRAND ADMIN INSERTED AN ORG ROW DIRECTLY");
  await brand.auth.signOut();

  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: anonErr } = await anon.rpc("operator_provision_org", {
    p_name: `PROBEORG-Anon-${S}`, p_delivery_brand: "direct",
    p_admin_email: `probeorg.anon.${S}@example.com`, p_admin_name: "Anon",
    p_reason: "an anonymous caller attempting to provision an org",
    p_token_hash: "x".repeat(16),
  });
  anonErr ? ok("an anonymous caller cannot provision an org")
          : bad("AN ANONYMOUS CALLER PROVISIONED AN ORGANISATION");
}

const op = await login(opAdmin.email);
console.log("\nB. An operator administrator can, and it does more than insert a row");
{
  const name = `PROBEORG-Client-${S}`;
  const { data: orgId, error } = await op.rpc("operator_provision_org", {
    p_name: name, p_delivery_brand: "OEA",
    p_admin_email: `probeorg.first.${S}@example.com`, p_admin_name: "First Admin",
    p_reason: "verification: provisioning a new OEA-delivered client",
    p_token_hash: "y".repeat(16),
  });
  if (error || !orgId) {
    bad(`provisioning failed — ${error?.message?.slice(0, 90)}`);
  } else {
    madeOrgIds.push(orgId);
    ok("the organisation was created");

    const { data: org } = await svc
      .from("orgs").select("slug, delivery_brand").eq("id", orgId).single();
    org?.slug === "probeorg-client-" + S.toLowerCase()
      ? ok(`slugified from its name (${org.slug})`)
      : bad(`unexpected slug: ${org?.slug}`);

    const { count: perms } = await svc
      .from("role_permissions").select("*", { count: "exact", head: true }).eq("org_id", orgId);
    perms > 0 ? ok(`the B7 permission baseline was seeded (${perms} entries)`)
              : bad("no permission baseline seeded");

    const { data: mod } = await svc
      .from("org_modules").select("enabled").eq("org_id", orgId).eq("module", "lettings").maybeSingle();
    mod?.enabled === true
      ? ok("lettings switched on — provisioned as an OEA brand")
      : bad("the lettings module was not set from the brand");

    const { count: nodes } = await svc
      .from("org_nodes").select("*", { count: "exact", head: true }).eq("org_id", orgId);
    nodes > 0 ? ok(`the geopolitical hierarchy was seeded (${nodes} nodes)`)
              : bad("no hierarchy seeded — the org has nowhere to file a property");

    const { data: inv } = await svc
      .from("invitations").select("role").eq("org_id", orgId).maybeSingle();
    inv?.role === "admin"
      ? ok("and one pending administrator invitation the nominee must accept")
      : bad(`invitation role was ${inv?.role}`);

    const { data: audit } = await svc
      .from("operator_actions").select("action, metadata")
      .eq("target_org", orgId).eq("action", "provision_org").maybeSingle();
    audit?.metadata?.slug === org?.slug
      ? ok("provisioning is audited, carrying the slug it set")
      : bad("no audit row, or its metadata does not carry the slug");
  }
}

console.log("\nC. A slug collision resolves instead of colliding");
{
  const name = `PROBEORG-Client-${S}`; // same name as the org above
  const { data: orgId2, error } = await op.rpc("operator_provision_org", {
    p_name: name, p_delivery_brand: "direct",
    p_admin_email: `probeorg.second.${S}@example.com`, p_admin_name: "Second Admin",
    p_reason: "verification: a second org sharing the first one's name",
    p_token_hash: "z".repeat(16),
  });
  if (error || !orgId2) {
    bad(`the second org could not be created — ${error?.message?.slice(0, 90)}`);
  } else {
    madeOrgIds.push(orgId2);
    const { data: org2 } = await svc.from("orgs").select("slug").eq("id", orgId2).single();
    org2?.slug && org2.slug !== `probeorg-client-${S.toLowerCase()}`
      ? ok(`the same name resolved to a distinct slug (${org2.slug})`)
      : bad(`THE SECOND ORG COLLIDED OR GOT NO SLUG (${org2?.slug})`);
  }

  // A second TFML-branded org must not steal '/o/tfml' from the real one.
  const { data: realTfml } = await svc.from("orgs").select("id, slug").eq("slug", "tfml").maybeSingle();
  const { data: orgId3, error: e3 } = await op.rpc("operator_provision_org", {
    p_name: `PROBEORG-SecondTFML-${S}`, p_delivery_brand: "TFML",
    p_admin_email: `probeorg.tfml2.${S}@example.com`, p_admin_name: "Second TFML Admin",
    p_reason: "verification: a second TFML-branded org must not steal the vanity slug",
    p_token_hash: "w".repeat(16),
  });
  if (e3 || !orgId3) {
    bad(`the second TFML-branded org could not be created — ${e3?.message?.slice(0, 90)}`);
  } else {
    madeOrgIds.push(orgId3);
    const { data: org3 } = await svc.from("orgs").select("slug").eq("id", orgId3).single();
    if (!realTfml) {
      org3?.slug === "tfml"
        ? ok(`no pre-existing "tfml" org in this environment, so it claimed the base slug (${org3.slug})`)
        : bad(`unexpected slug with no collision to resolve: ${org3?.slug}`);
    } else {
      org3?.slug && org3.slug !== "tfml"
        ? ok(`a second TFML-branded org got its own slug (${org3.slug}), not "tfml"`)
        : bad(`A SECOND TFML ORG TOOK "tfml"'S SLUG (${org3?.slug})`);

      const { data: stillReal } = await svc.from("orgs").select("slug").eq("id", realTfml.id).single();
      stillReal.slug === "tfml"
        ? ok("the real TFML org's slug is untouched")
        : bad(`THE REAL TFML ORG'S SLUG CHANGED TO ${stillReal.slug}`);
    }
  }
}

console.log("\nD. Refused with no real reason, no name, or no admin email");
{
  const cases = [
    ["a reason that says nothing", {
      p_name: `PROBEORG-NoReason-${S}`, p_delivery_brand: "direct",
      p_admin_email: `probeorg.x.${S}@example.com`, p_admin_name: "X",
      p_reason: "short", p_token_hash: "a".repeat(16),
    }],
    ["no name", {
      p_name: "  ", p_delivery_brand: "direct",
      p_admin_email: `probeorg.y.${S}@example.com`, p_admin_name: "Y",
      p_reason: "verification: an organisation needs a name", p_token_hash: "b".repeat(16),
    }],
    ["no admin email", {
      p_name: `PROBEORG-NoEmail-${S}`, p_delivery_brand: "direct",
      p_admin_email: "  ", p_admin_name: "Z",
      p_reason: "verification: the first administrator needs an email", p_token_hash: "c".repeat(16),
    }],
  ];
  for (const [label, args] of cases) {
    const { data, error } = await op.rpc("operator_provision_org", args);
    error ? ok(`${label} is refused`) : bad(`PROVISIONED WITH ${label.toUpperCase()} (org ${data})`);
    if (!error && data) madeOrgIds.push(data);
  }
}

await op.auth.signOut();

// ── Cleanup ──────────────────────────────────────────────────────────────
for (const id of madeOrgIds) {
  await svc.from("orgs").update({ deleted_at: new Date().toISOString() }).eq("id", id);
}
for (const id of madeUserIds) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
if (!wasOperator) {
  await svc.from("orgs").update({ is_platform_operator: false }).eq("id", operatorOrg.id);
}
console.log(`\n(retired ${madeOrgIds.length} probe organisation(s) and ${madeUserIds.length} probe user(s))`);

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — every org provisioned through the product gets a working address, and only an operator can make one."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
