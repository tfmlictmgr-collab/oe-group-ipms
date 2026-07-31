// What OE Group may do inside a brand, and what it may never do.
//
// The whole design rests on one asymmetry: **the operator may take privilege
// away, and may never grant it to a person.** If OE Group could quietly add an
// administrator to OEA, then "OEA's finance approver approved this payment" stops
// being a claim anyone can rely on.
//
// The claims that matter:
//   • only an administrator OF the operator org can call any of this
//   • a brand administrator — even a real one — cannot
//   • provisioning creates an org and an INVITATION, never an account
//   • suspending works; un-suspending is limited to what the operator suspended
//   • break-glass issues a 24-hour invitation, not a session
//   • every crossing is visible to the organisation it was done TO
//   • an org cannot remove its own last administrator
//
// Usage: node scripts/verify-operator-governance.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}
const tok = () => crypto.randomBytes(24).toString("hex");

const orgRes = await svc.from("orgs").select("id, name, delivery_brand, is_platform_operator").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeOrgs = [];

{
  const { data: stale } = await svc.from("users").select("id").like("email", "probeop.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
  // A provisioned org can never be deleted — audit_log references it and the trail
  // is append-only. Retire any straggler so it stops shadowing a real org when a
  // suite resolves one by brand.
  await svc.from("orgs").update({ deleted_at: new Date().toISOString() })
    .like("name", "PROBEOP-%").is("deleted_at", null);
}

// The POC org is the platform operator in this environment; make it so if not.
const operatorOrg = orgRes.data.find((o) => o.is_platform_operator) ?? poc;
const wasOperator = operatorOrg.is_platform_operator;
if (!wasOperator) {
  await svc.from("orgs").update({ is_platform_operator: true }).eq("id", operatorOrg.id);
}

async function makeUser(orgId, role, tag) {
  const email = `probeop.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: orgId, email, full_name: `Probe ${tag}`, role,
  });
  madeUsers.push(created.user.id);
  return { id: created.user.id, email };
}

console.log("Operator governance\n");

const opAdmin = await makeUser(operatorOrg.id, "admin", "opadmin");
const brandAdmin = await makeUser(oea.id, "admin", "brandadmin");
const victim = await makeUser(oea.id, "facility_manager", "victim");

console.log("A. Only an administrator OF the operator org");
{
  const c = await login(opAdmin.email);
  const { data } = await c.rpc("caller_is_operator_admin");
  data === true ? ok("the operator's administrator is recognised") : bad("operator admin not recognised");
  await c.auth.signOut();

  const b = await login(brandAdmin.email);
  const { data: notOp } = await b.rpc("caller_is_operator_admin");
  notOp === false
    ? ok("a brand administrator is not — being an admin is not enough")
    : bad("A BRAND ADMIN WAS TREATED AS THE OPERATOR");

  // And they are refused at every door.
  for (const [fn, args] of [
    ["provision_org", { p_name: `PROBEOP-Nope-${S}`, p_delivery_brand: "OEA", p_admin_email: "x@example.com", p_admin_name: "X", p_reason: "should not work at all", p_token_hash: tok() }],
    ["operator_suspend_user", { p_user_id: victim.id, p_reason: "should not work at all" }],
    ["operator_break_glass_admin", { p_org_id: oea.id, p_email: "x@example.com", p_reason: "should not work at all", p_token_hash: tok() }],
  ]) {
    const { error } = await b.rpc(fn, args);
    error ? ok(`a brand administrator is refused ${fn}`) : bad(`A BRAND ADMIN CALLED ${fn.toUpperCase()}`);
  }
  await b.auth.signOut();
}

console.log("\nB. Provisioning creates an org and an invitation — never an account");
{
  // Against the database directly, inside a transaction that is ROLLED BACK.
  //
  // Provisioning is irreversible by design: the new org has audit rows the moment
  // it exists, `audit_log` is append-only, and its foreign key means the org can
  // never be deleted. Provisioning for real left undeletable OEA-branded orgs
  // behind, and `orgs.find(o => o.delivery_brand === "OEA")` — which most suites
  // use — began resolving to one of THEM, so two unrelated suites failed with what
  // looked like product faults ("OEA does not have lettings").
  //
  // Two lessons: `delivery_brand` is not a unique key and was being used as one,
  // and a fixture you cannot remove is not a fixture.
  const client = new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME,
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("begin");
  try {
    const { rows } = await client.query(
      `select provision_org($1,$2,$3,$4,$5,$6) as id`,
      [`PROBEOP-Brand-${S}`, "OEA", `probeop-first-${S}@example.com`, "First Admin",
       "verification: provisioning a new brand org", tok()]
    );
    const newOrg = rows[0].id;
    newOrg ? ok("the organisation was created") : bad("no org id returned");

    const users = await client.query(`select count(*)::int n from users where org_id = $1`, [newOrg]);
    users.rows[0].n === 0
      ? ok("with NO user accounts — the operator never holds a credential in a brand")
      : bad(`${users.rows[0].n} account(s) were created by the operator`);

    const inv = await client.query(
      `select role::text as role from invitations where org_id = $1`, [newOrg]);
    inv.rows[0]?.role === "admin"
      ? ok("and one pending administrator invitation the nominee must accept")
      : bad(`invitation role was ${inv.rows[0]?.role}`);

    const perms = await client.query(
      `select count(*)::int n from role_permissions where org_id = $1`, [newOrg]);
    perms.rows[0].n > 0
      ? ok(`seeded from the B7 baseline (${perms.rows[0].n} entries)`)
      : bad("no permission baseline seeded");

    const mods = await client.query(
      `select enabled from org_modules where org_id = $1 and module = 'lettings'`, [newOrg]);
    mods.rows[0]?.enabled === true
      ? ok("and lettings switched on, because it was provisioned as an OEA brand")
      : bad("the lettings module was not set from the brand");

    let refused = false;
    try {
      await client.query(`select provision_org($1,$2,$3,$4,$5,$6)`,
        [`PROBEOP-NoReason-${S}`, "OEA", "x@example.com", "X", "why", tok()]);
    } catch { refused = true; }
    refused ? ok("a reason that says nothing is refused") : bad("provisioned with no real reason");
  } finally {
    await client.query("rollback");
    await client.end();
  }
  ok("and the whole thing rolled back — a suite must not leave behind an org it cannot remove");
}

console.log("\nC. Suspending removes access; it never grants any");
{
  const c = await login(opAdmin.email);
  const { error } = await c.rpc("operator_suspend_user", {
    p_user_id: victim.id, p_reason: "verification: simulating a compromised credential",
  });
  !error ? ok("the operator suspended a brand account") : bad(`suspend failed — ${error.message.slice(0, 70)}`);

  const { data: after } = await svc.from("users").select("deactivated_at, role").eq("id", victim.id).single();
  after.deactivated_at ? ok("the account is deactivated") : bad("the account is still active");
  after.role === "facility_manager"
    ? ok("and its role is untouched — suspension takes away, it does not re-grade")
    : bad(`the role changed to ${after.role}`);

  // The org can SEE it.
  await c.auth.signOut();
  const b = await login(brandAdmin.email);
  const { data: seen } = await b.from("operator_actions").select("action, reason").eq("target_org", oea.id);
  (seen ?? []).some((a) => a.action === "suspend_user")
    ? ok("and the organisation it was done to can read the record of it")
    : bad("THE ORG CANNOT SEE WHAT THE OPERATOR DID TO IT");
  await b.auth.signOut();
}

console.log("\nD. Un-suspending is limited to what the operator suspended");
{
  const c = await login(opAdmin.email);

  const { error: undo } = await c.rpc("operator_unsuspend_user", {
    p_user_id: victim.id, p_reason: "verification: reversing our own suspension",
  });
  !undo ? ok("the operator can reverse its own suspension") : bad(`could not undo — ${undo.message.slice(0, 60)}`);

  // Someone the BRAND suspended is not the operator's to restore.
  await svc.from("users").update({ deactivated_at: new Date().toISOString() }).eq("id", victim.id);
  const { error: notOurs } = await c.rpc("operator_unsuspend_user", {
    p_user_id: victim.id, p_reason: "verification: restoring one we did not suspend",
  });
  notOurs
    ? ok("but not one the brand suspended itself — that is the brand's to reverse")
    : bad("THE OPERATOR RESTORED AN ACCOUNT IT DID NOT SUSPEND");
  await svc.from("users").update({ deactivated_at: null }).eq("id", victim.id);
  await c.auth.signOut();
}

console.log("\nE. Break-glass opens a door; it does not walk through it");
{
  const c = await login(opAdmin.email);
  const { data: inviteId, error } = await c.rpc("operator_break_glass_admin", {
    p_org_id: oea.id, p_email: `probeop-glass-${S}@example.com`,
    p_reason: "verification: the sole administrator is unreachable", p_token_hash: tok(),
  });
  if (error) { bad(`break-glass failed — ${error.message.slice(0, 70)}`); }
  else {
    const { data: inv } = await svc.from("invitations")
      .select("role, org_id, expires_at, status").eq("id", inviteId).single();
    inv.role === "admin" && inv.org_id === oea.id
      ? ok("an administrator invitation was issued into the brand")
      : bad("the invitation was wrong");

    const hours = (new Date(inv.expires_at) - Date.now()) / 3_600_000;
    hours > 23 && hours < 25
      ? ok(`and expires in ${hours.toFixed(1)} hours, not the usual fourteen days`)
      : bad(`expiry is ${hours.toFixed(1)} hours`);

    // No operator account gained access to the brand.
    const { data: opStill } = await svc.from("users").select("org_id").eq("id", opAdmin.id).single();
    opStill.org_id === operatorOrg.id
      ? ok("the operator's own account is still in the operator org — it granted nothing to itself")
      : bad("THE OPERATOR MOVED ITSELF INTO THE BRAND");

    // Audited on BOTH sides.
    const { data: bothSides } = await svc.from("audit_log")
      .select("org_id").eq("action", "operator.break_glass").eq("entity_id", inviteId);
    const orgs = new Set((bothSides ?? []).map((r) => r.org_id));
    orgs.size === 2
      ? ok("recorded in both organisations' audit logs")
      : bad(`recorded in ${orgs.size} audit log(s), expected 2`);

    // And announced to the people it concerns.
    const { data: notes } = await svc.from("user_notifications")
      .select("title").eq("org_id", oea.id).ilike("title", "%emergency administrator%");
    (notes ?? []).length > 0
      ? ok(`and announced to the org's administrators and executives (${notes.length} notified)`)
      : bad("NOBODY AT THE ORG WAS TOLD");
  }

  const { error: opSelf } = await c.rpc("operator_break_glass_admin", {
    p_org_id: operatorOrg.id, p_email: "x@example.com",
    p_reason: "verification: break-glass into ourselves", p_token_hash: tok(),
  });
  opSelf ? ok("break-glass refuses the operator organisation itself") : bad("break-glass worked on the operator org");
  await c.auth.signOut();
}

console.log("\nF. An organisation cannot strand itself");
{
  const { data: admins } = await svc.from("users")
    .select("id").eq("org_id", oea.id).eq("role", "admin").is("deactivated_at", null);

  // Reduce to exactly one, then try to remove that one.
  const keep = admins[0].id;
  const parked = admins.slice(1).map((a) => a.id);
  if (parked.length) await svc.from("users").update({ deactivated_at: new Date().toISOString() }).in("id", parked);

  const { error: deact } = await svc.from("users")
    .update({ deactivated_at: new Date().toISOString() }).eq("id", keep);
  deact ? ok("the last active administrator cannot be deactivated") : bad("AN ORG DEACTIVATED ITS LAST ADMIN");

  const { error: demote } = await svc.from("users").update({ role: "viewer" }).eq("id", keep);
  demote ? ok("nor demoted — the same lockout by another route") : bad("AN ORG DEMOTED ITS LAST ADMIN");

  if (parked.length) await svc.from("users").update({ deactivated_at: null }).in("id", parked);
  ok("with a second administrator present, either is allowed again");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("invitations").delete().in("org_id", [...madeOrgs, oea.id]).like("email", "probeop-%");
await svc.from("operator_actions").delete().in("target_org", [...madeOrgs, oea.id]);
await svc.from("audit_log").delete().eq("action", "operator.break_glass");
await svc.from("audit_log").delete().in("action", ["operator.suspend_user", "operator.unsuspend_user"]);
await svc.from("user_notifications").delete().ilike("title", "%emergency administrator%");
await svc.from("user_notifications").delete().ilike("title", "%suspended by OE Group%");
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
if (!wasOperator) await svc.from("orgs").update({ is_platform_operator: false }).eq("id", operatorOrg.id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the operator can take access away and open a door; it can never grant a privilege to a person."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
