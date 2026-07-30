// Who may create whom, and how far a regional manager's authority reaches.
//
// Three faults this guards, all found by asking whether a regional manager could
// actually invite anyone:
//   • `invitations_insert` admitted only admin and facility_manager, so the
//     `people.invite` capability a regional manager held was decorative
//   • the escalation guard named ONE role (`role <> 'admin'`), leaving a facility
//     manager able to mint an `executive` — the MD who co-approves payments above
//     the threshold
//   • an invitation could not carry a region, so the role could not be granted
//     with its scope in one act
//
// The rule now: **you may invite a role strictly below your own rank**, and a node
// you hand out must be one you can reach.
//
// Usage: node scripts/verify-role-hierarchy.mjs
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

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const orgRes = await svc.from("orgs").select("id, delivery_brand");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeNodes = [];
const madeInvites = [];

{
  const { data: stale } = await svc.from("users").select("id").like("email", "probehier.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
  await svc.from("invitations").delete().like("email", "probehier-invitee%@oegroup.test");
}

async function makeUser(role) {
  const email = `probehier.${role}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: poc.id, email, full_name: `Probe ${role}`, role,
  });
  madeUsers.push(created.user.id);
  return { id: created.user.id, email };
}

const tryInvite = async (client, inviterId, role, nodeId = null) => {
  const { error } = await client.from("invitations").insert({
    org_id: poc.id,
    email: `probehier-invitee-${role}-${S}-${Math.random().toString(36).slice(2, 7)}@oegroup.test`,
    role,
    node_id: nodeId,
    token_hash: `probe-${S}-${Math.random().toString(36).slice(2, 10)}`,
    invited_by: inviterId,
  });
  return error;
};

console.log("Role hierarchy and invitation\n");

console.log("A. The rank ladder");
{
  const expected = [
    ["admin", 100], ["executive", 90], ["finance_approver", 70],
    ["regional_manager", 60], ["facility_manager", 50], ["fm_ops_staff", 30],
    ["tenant", 10],
  ];
  let allOk = true;
  for (const [role, rank] of expected) {
    const { data } = await svc.rpc("role_rank", { p_role: role });
    if (Number(data) !== rank) { allOk = false; bad(`role_rank(${role}) = ${data}, expected ${rank}`); }
  }
  if (allOk) ok("a regional manager (60) outranks a facility manager (50), below finance (70)");
}

console.log("\nB. A regional manager can invite — which they could not before");
{
  const rm = await makeUser("regional_manager");
  const c = await login(rm.email);

  const e1 = await tryInvite(c, rm.id, "fm_ops_staff");
  !e1 ? ok("invites operational staff") : bad(`REFUSED — ${e1.message.slice(0, 70)}`);

  const e2 = await tryInvite(c, rm.id, "facility_manager");
  !e2 ? ok("and a facility manager, who ranks below them") : bad(`refused an FM — ${e2.message.slice(0, 60)}`);

  await c.auth.signOut();
}

console.log("\nC. …and cannot invite at or above their own rank");
{
  const rm = madeUsers.length ? await svc.from("users").select("id, email").eq("id", madeUsers[0]).single() : null;
  const c = await login(rm.data.email);

  for (const role of ["regional_manager", "finance_approver", "executive", "admin"]) {
    const e = await tryInvite(c, rm.data.id, role);
    e ? ok(`refused to issue ${role}`) : bad(`A REGIONAL MANAGER MINTED A ${role.toUpperCase()}`);
  }
  await c.auth.signOut();
}

console.log("\nD. The hole that was open: a facility manager and the executive role");
{
  const fm = await makeUser("facility_manager");
  const c = await login(fm.email);

  const e1 = await tryInvite(c, fm.id, "executive");
  e1 ? ok("a facility manager cannot mint an executive — the MD who approves above threshold")
     : bad("A FACILITY MANAGER CREATED AN EXECUTIVE");

  const e2 = await tryInvite(c, fm.id, "regional_manager");
  e2 ? ok("nor a regional manager, who outranks them")
     : bad("A FACILITY MANAGER CREATED A REGIONAL MANAGER");

  const e3 = await tryInvite(c, fm.id, "admin");
  e3 ? ok("nor an administrator — the case the old guard did cover")
     : bad("A FACILITY MANAGER CREATED AN ADMIN");

  const e4 = await tryInvite(c, fm.id, "fm_ops_staff");
  !e4 ? ok("but still invites their own operational staff") : bad(`an FM lost the ability to invite ops staff — ${e4.message.slice(0, 60)}`);

  await c.auth.signOut();
}

console.log("\nE. An administrator issues anything below themselves");
{
  const c = await login("demo@oegroup.test");
  const { data: admin } = await c.from("users").select("id").eq("email", "demo@oegroup.test").single();
  for (const role of ["executive", "regional_manager", "finance_approver"]) {
    const e = await tryInvite(c, admin.id, role);
    !e ? ok(`an administrator may issue ${role}`) : bad(`the admin was refused ${role} — ${e.message.slice(0, 60)}`);
  }
  // The peer exception. "Strictly below" alone left an organisation with one
  // administrator unable to appoint a second — a lockout, and the pressure that
  // makes operators build a standing super-admin.
  const eAdmin = await tryInvite(c, admin.id, "admin");
  !eAdmin
    ? ok("and may appoint a peer administrator — an org is never one resignation from stranded")
    : bad(`an administrator cannot appoint another — ${eAdmin.message.slice(0, 60)}`);
  await c.auth.signOut();
}

console.log("\nF. A region cannot be handed outside the one you hold");
{
  const mk = async (parent, level, name) => {
    const { data, error } = await svc.from("org_nodes")
      .insert({ org_id: poc.id, parent_id: parent, level, name, path: "" }).select("id").single();
    if (error) throw new Error(error.message);
    madeNodes.push(data.id);
    return data.id;
  };
  const north = await mk(null, "region", `PROBEHIER-North-${S}`);
  const northProject = await mk(north, "project", `PROBEHIER-NProj-${S}`);
  const south = await mk(null, "region", `PROBEHIER-South-${S}`);

  const rm = await svc.from("users").select("id, email").eq("id", madeUsers[0]).single();
  await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: rm.data.id, node_id: north, relation: "manager" });

  const c = await login(rm.data.email);

  const eIn = await tryInvite(c, rm.data.id, "facility_manager", northProject);
  !eIn ? ok("a regional manager hands out a project inside their own region")
       : bad(`refused a node in their own subtree — ${eIn.message.slice(0, 70)}`);

  const eOut = await tryInvite(c, rm.data.id, "facility_manager", south);
  eOut ? ok("and cannot hand out a region they do not hold")
       : bad("A REGIONAL MANAGER GRANTED SCOPE OVER ANOTHER REGION");

  await c.auth.signOut();
  await svc.from("property_stakeholders").delete().eq("user_id", rm.data.id);
}

console.log("\nG. A regional manager supersedes the FM/PM in the policies too");
{
  const rm = await svc.from("users").select("id, email").eq("id", madeUsers[0]).single();
  const c = await login(rm.data.email);

  // Each of these named `facility_manager` and not `regional_manager` before.
  const reads = {
    vendor_applications: await c.from("vendor_applications").select("id").limit(1),
    vendor_evaluations: await c.from("vendor_evaluations").select("id").limit(1),
    vendor_overview: await c.from("vendor_overview").select("id").limit(1),
    payments: await c.from("payments").select("id").limit(1),
  };
  const denied = Object.entries(reads).filter(([, r]) => r.error).map(([k]) => k);
  denied.length === 0
    ? ok("reads vendor applications, evaluations, the vendor overview and payments")
    : bad(`still refused: ${denied.join(", ")}`);

  const { data: fmRoles } = await svc.rpc("fm_roles");
  (fmRoles ?? []).includes("regional_manager")
    ? ok("fm_roles() names both, so the next policy change moves them together")
    : bad(`fm_roles() = ${JSON.stringify(fmRoles)}`);
  await c.auth.signOut();
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("invitations").delete().like("email", "probehier-invitee%@oegroup.test");
await svc.from("property_stakeholders").delete().in("user_id", madeUsers);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
for (const id of [...madeNodes].reverse()) await svc.from("org_nodes").delete().eq("id", id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — you may only create someone below you, and only inside a region you hold."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
