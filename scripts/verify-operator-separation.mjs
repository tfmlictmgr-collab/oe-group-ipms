// The control plane is its own organisation, and holds no client data.
//
// The claims that matter:
//   • exactly one org is the operator, and it is not the POC
//   • the operator org holds no properties, tickets or applications — enforced,
//     not merely true today
//   • the POC kept every record it had, and lost only its authority
//   • a POC administrator can no longer provision, retire or govern anything
//   • the operator admin can, and sees the directory
//   • every tenant org's admin sees an empty directory, not a refusal
//
// Usage: node scripts/verify-operator-separation.mjs
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
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  return error ? null : c;
};

const { data: orgs, error } = await svc
  .from("orgs").select("id, name, slug, is_platform_operator").is("deleted_at", null);
if (error) { console.error("db unreachable:", error.message); process.exit(1); }

const operator = orgs.find((o) => o.is_platform_operator);
const poc = orgs.find((o) => o.slug === "oe-group-foundation-poc");
const tfml = orgs.find((o) => o.slug === "tfml");

console.log("The operator is its own organisation\n");

console.log("A. Exactly one operator, and it is the control plane");
{
  const flagged = orgs.filter((o) => o.is_platform_operator);
  flagged.length === 1
    ? ok(`exactly one organisation is the operator (${flagged[0].name})`)
    : bad(`${flagged.length} organisations carry the operator flag`);

  operator?.slug === "oe-group"
    ? ok("it is OE Group, not a delivery brand or a demo tenant")
    : bad(`the operator is "${operator?.slug}"`);

  poc && !poc.is_platform_operator
    ? ok("the Foundation POC is now an ordinary tenant")
    : bad("THE POC STILL GOVERNS THE PLATFORM");
}

console.log("\nB. The control plane holds no client data — enforced, not observed");
{
  for (const [table, extra] of [
    ["properties", { name: `PROBESEP-Property` }],
    ["tickets", { channel: "portal", message_text: "PROBESEP ticket" }],
    ["tenant_applications", {
      type: "individual", applicant_name: "PROBESEP Applicant",
      applicant_email: "probesep@oegroup-probe.test",
    }],
  ]) {
    const { error: e } = await svc.from(table).insert({ org_id: operator.id, ...extra });
    e ? ok(`a row in ${table} cannot be filed against the operator org`)
      : bad(`A ${table.toUpperCase()} ROW WAS CREATED ON THE CONTROL PLANE`);
  }

  // And it is genuinely empty right now, not merely closed to new rows.
  for (const table of ["properties", "tickets", "tenant_applications"]) {
    const { count } = await svc
      .from(table).select("id", { count: "exact", head: true }).eq("org_id", operator.id);
    count === 0
      ? ok(`the operator org holds zero ${table}`)
      : bad(`the operator org holds ${count} ${table}`);
  }

  // The same insert must still work for a tenant, or the trigger is too broad.
  const { data: t, error: te } = await svc.from("tickets").insert({
    org_id: tfml.id, channel: "portal", message_text: `PROBESEP tenant ticket`,
    category: "maintenance", urgency: "normal",
  }).select("id").single();
  te ? bad(`the trigger blocks a TENANT ticket too — ${te.message.slice(0, 60)}`)
     : ok("a tenant organisation is unaffected — the guard is not over-broad");
  if (t) await svc.from("tickets").delete().eq("id", t.id);
}

console.log("\nC. The POC kept its records and lost only its authority");
{
  const { count: props } = await svc
    .from("properties").select("id", { count: "exact", head: true })
    .eq("org_id", poc.id).is("deleted_at", null);
  props > 0
    ? ok(`the POC still holds its ${props} properties`)
    : bad("THE POC LOST ITS DATA");

  const c = await login("oe-group-foundation-poc.admin@oegroup.test");
  if (!c) bad("could not sign in as the POC administrator");
  else {
    const { data: dir } = await c.rpc("operator_org_directory");
    (dir ?? []).length === 0
      ? ok("a POC administrator now sees an empty directory, not a refusal")
      : bad(`A POC ADMIN LISTED ${(dir ?? []).length} ORGANISATIONS`);

    const { error: pe } = await c.rpc("provision_org", {
      p_name: "PROBESEP Should Not Exist", p_delivery_brand: "direct",
      p_admin_email: "nobody@oegroup-probe.test", p_admin_name: "Nobody",
      p_reason: "This must be refused outright.", p_token_hash: "x".repeat(64),
    });
    pe ? ok("and cannot provision an organisation") : bad("A POC ADMIN PROVISIONED AN ORG");

    const { error: re } = await c.rpc("retire_org", {
      p_org_id: tfml.id, p_reason: "This must be refused outright.",
    });
    re ? ok("nor retire one") : bad("A POC ADMIN RETIRED AN ORG");
    await c.auth.signOut();
  }
}

console.log("\nD. The operator administrator holds the authority instead");
{
  const c = await login("platform@oegroup.test");
  if (!c) bad("could not sign in as the platform administrator");
  else {
    const { data: isOp } = await c.rpc("caller_is_operator_admin");
    isOp === true ? ok("caller_is_operator_admin() is true for them") : bad(`it returned ${isOp}`);

    const { data: dir } = await c.rpc("operator_org_directory");
    (dir ?? []).length >= 3
      ? ok(`and the directory lists every organisation (${(dir ?? []).length})`)
      : bad(`the directory returned ${(dir ?? []).length} rows`);

    const listsSelf = (dir ?? []).some((o) => o.is_platform_operator);
    listsSelf ? ok("including itself, badged as the operator") : bad("the operator is missing from its own list");
    await c.auth.signOut();
  }
}

console.log("\nE. Tenant administrators are scoped to their own organisation");
{
  for (const email of ["tfml.admin@oegroup.test", "oea.admin@oegroup.test"]) {
    const c = await login(email);
    if (!c) { bad(`could not sign in as ${email}`); continue; }
    const { data: dir } = await c.rpc("operator_org_directory");
    (dir ?? []).length === 0
      ? ok(`${email.split("@")[0]} sees an empty directory`)
      : bad(`${email} LISTED ${(dir ?? []).length} ORGANISATIONS`);
    await c.auth.signOut();
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — administering a tenant no longer implies governing the platform."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
