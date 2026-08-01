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

const orgRes = await svc.from("orgs").select("id, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeNodes = [];
const madeProps = [];
const madeUnits = [];
const madeVendors = [];
const madeInvites = [];

const mkProp = async (name) => {
  const { data, error } = await svc.from("properties").insert({ org_id: poc.id, name }).select("id").single();
  if (error) throw new Error(error.message);
  madeProps.push(data.id);
  return data.id;
};

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

// Every scope-bearing column, not just the one most recently added.
//
// The previous version only ever set `node_id`, which is exactly why audit 0729c
// found `property_ids` / `unit_id` / `vendor_id` unchecked: a test that exercises
// the field you were thinking about confirms the thought, not the boundary.
const tryInvite = async (client, inviterId, role, extra = {}) => {
  const { error } = await client.from("invitations").insert({
    org_id: poc.id,
    email: `probehier-invitee-${role}-${S}-${Math.random().toString(36).slice(2, 7)}@oegroup.test`,
    role,
    token_hash: `probe-${S}-${Math.random().toString(36).slice(2, 10)}`,
    invited_by: inviterId,
    ...extra,
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
  const c = await login("oe-group-foundation-poc.admin@oegroup.test");
  const { data: admin } = await c.from("users").select("id").eq("email", "oe-group-foundation-poc.admin@oegroup.test").single();
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
  // REGION → LOCATION → PROJECT → SITE (0087). A project is no longer a child
  // of a region — it hangs under the city it happens in — so the grantable node
  // now sits TWO levels below the region the manager holds. That is the better
  // test of the two: the guard is `target.path like mine.path || '%'`, a prefix
  // over the materialised path, and reach was never meant to stop at the
  // immediate child. Under the old order this assertion could not tell a
  // subtree check from a parent check, because they agreed on every row it made.
  const north = await mk(null, "region", `PROBEHIER-North-${S}`);
  const northCity = await mk(north, "location", `PROBEHIER-NCity-${S}`);
  const northProject = await mk(northCity, "project", `PROBEHIER-NProj-${S}`);
  const south = await mk(null, "region", `PROBEHIER-South-${S}`);

  const rm = await svc.from("users").select("id, email").eq("id", madeUsers[0]).single();
  await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: rm.data.id, node_id: north, relation: "manager" });

  const c = await login(rm.data.email);

  const eIn = await tryInvite(c, rm.data.id, "facility_manager", { node_id: northProject });
  !eIn ? ok("a regional manager hands out a project nested two levels inside their own region")
       : bad(`refused a node in their own subtree — ${eIn.message.slice(0, 70)}`);

  const eOut = await tryInvite(c, rm.data.id, "facility_manager", { node_id: south });
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

console.log("\nH. Every attachment an invitation carries is scoped (audit 0729c-S1)");
{
  const rm = await svc.from("users").select("id, email").eq("id", madeUsers[0]).single();

  // Two properties: one the regional manager reaches, one they do not.
  const mkProp = async (name, siteNode) => {
    const { data, error } = await svc.from("properties")
      .insert({ org_id: poc.id, name, site_node_id: siteNode ?? null }).select("id").single();
    if (error) throw new Error(error.message);
    madeProps.push(data.id);
    return data.id;
  };

  const mk = async (parent, level, name) => {
    const { data, error } = await svc.from("org_nodes")
      .insert({ org_id: poc.id, parent_id: parent, level, name, path: "" }).select("id").single();
    if (error) throw new Error(error.message);
    madeNodes.push(data.id);
    return data.id;
  };
  const region = await mk(null, "region", `PROBEHIER-H-Region-${S}`);
  const location = await mk(region, "location", `PROBEHIER-H-Loc-${S}`);
  const project = await mk(location, "project", `PROBEHIER-H-Proj-${S}`);
  const site = await mk(project, "site", `PROBEHIER-H-Site-${S}`);

  const mine = await mkProp(`PROBEHIER-H-Mine-${S}`, site);
  const theirs = await mkProp(`PROBEHIER-H-Theirs-${S}`, null);

  await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: rm.data.id, node_id: region, relation: "manager" });

  const c = await login(rm.data.email);

  const eMine = await tryInvite(c, rm.data.id, "facility_manager", { property_ids: [mine] });
  !eMine
    ? ok("a manager may attach an invitee to a property inside their own region")
    : bad(`refused a property in their own subtree — ${eMine.message.slice(0, 70)}`);

  const eTheirs = await tryInvite(c, rm.data.id, "facility_manager", { property_ids: [theirs] });
  eTheirs
    ? ok("and may NOT attach one to a property outside it — the 0729c-S1 hole")
    : bad("A MANAGER PLANTED SOMEONE ON A PROPERTY OUTSIDE THEIR REGION");

  const eMixed = await tryInvite(c, rm.data.id, "facility_manager", { property_ids: [mine, theirs] });
  eMixed
    ? ok("one bad property in the array fails the whole invitation")
    : bad("A MIXED ARRAY SLIPPED A FOREIGN PROPERTY THROUGH");

  // Tenant enrolment: the unit's property has to be reachable too.
  const { data: unitOut } = await svc.from("units")
    .insert({ org_id: poc.id, property_id: theirs, label: `H-${S}`, apportionment_factor: 1 })
    .select("id").single();
  madeUnits.push(unitOut.id);
  const eUnit = await tryInvite(c, rm.data.id, "tenant", { unit_id: unitOut.id });
  eUnit
    ? ok("nor enrol a tenant into a unit on a property they do not reach")
    : bad("A MANAGER ENROLLED A TENANT OUTSIDE THEIR REGION");

  await c.auth.signOut();

  // An administrator is unbounded, as before.
  const a = await login("oe-group-foundation-poc.admin@oegroup.test");
  const { data: admin } = await a.from("users").select("id").eq("email", "oe-group-foundation-poc.admin@oegroup.test").single();
  const eAdmin = await tryInvite(a, admin.id, "facility_manager", { property_ids: [theirs] });
  !eAdmin
    ? ok("an administrator may still attach anyone to any property in the org")
    : bad(`the administrator was blocked — ${eAdmin.message.slice(0, 60)}`);
  await a.auth.signOut();

  await svc.from("property_stakeholders").delete().eq("user_id", rm.data.id);
}

console.log("\nH2. `vendor_id` is scoped the same way (audit 0729d-L1)");
{
  // The 0729c-S1 fix covered property_ids, unit_id — and vendor_id, but nothing
  // exercised vendor_id specifically. Flagged by 0729d as a genuine gap, code
  // correct on inspection but unproven.
  const rm = await svc.from("users").select("id, email").eq("id", madeUsers[0]).single();
  const mine = await mkProp(`PROBEHIER-V-Mine-${S}`);
  const theirs = await mkProp(`PROBEHIER-V-Theirs-${S}`);

  await svc.from("property_stakeholders")
    .insert({ org_id: poc.id, user_id: rm.data.id, property_id: mine, relation: "manager" });

  const mkVendor = async (name) => {
    const { data, error } = await svc.from("vendors").insert({ org_id: poc.id, name }).select("id").single();
    if (error) throw new Error(error.message);
    madeVendors.push(data.id);
    return data.id;
  };
  const vendorMine = await mkVendor(`PROBEHIER-VendorMine-${S}`);
  const vendorTheirs = await mkVendor(`PROBEHIER-VendorTheirs-${S}`);
  await svc.from("vendor_properties").insert({ org_id: poc.id, vendor_id: vendorMine, property_id: mine });
  await svc.from("vendor_properties").insert({ org_id: poc.id, vendor_id: vendorTheirs, property_id: theirs });

  const c = await login(rm.data.email);
  const eMine = await tryInvite(c, rm.data.id, "vendor", { vendor_id: vendorMine });
  !eMine
    ? ok("a manager may attach an invitee to a vendor scoped to their own property")
    : bad(`refused a vendor within scope — ${eMine.message.slice(0, 70)}`);

  const eTheirs = await tryInvite(c, rm.data.id, "vendor", { vendor_id: vendorTheirs });
  eTheirs
    ? ok("and may NOT attach one to a vendor scoped to a property they do not reach")
    : bad("A MANAGER ATTACHED AN INVITEE TO A VENDOR OUTSIDE THEIR SCOPE");
  await c.auth.signOut();

  await svc.from("property_stakeholders").delete().eq("user_id", rm.data.id).eq("property_id", mine);
}

console.log("\nI. The loose definer primitive is gone (audit 0729c-S2)");
{
  const c = await login(madeUsers.length ? (await svc.from("users").select("email").eq("id", madeUsers[0]).single()).data.email : "oe-group-foundation-poc.admin@oegroup.test");
  const { error } = await c.rpc("apply_invitation_node", {
    p_invitation_id: "00000000-0000-0000-0000-000000000000",
    p_user_id: "00000000-0000-0000-0000-000000000000",
  });
  error
    ? ok("apply_invitation_node no longer exists — the node is applied inside accept_invitation")
    : bad("APPLY_INVITATION_NODE IS STILL CALLABLE BY A SIGNED-IN USER");
  await c.auth.signOut();

  const anon = createClient(URL_, ANON);
  const { error: anonErr } = await anon.rpc("apply_invitation_node", {
    p_invitation_id: "00000000-0000-0000-0000-000000000000",
    p_user_id: "00000000-0000-0000-0000-000000000000",
  });
  anonErr ? ok("and is unreachable anonymously — it was executable by anon") : bad("ANON CAN STILL CALL IT");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("invitations").delete().like("email", "probehier-invitee%@oegroup.test");
await svc.from("property_stakeholders").delete().in("user_id", madeUsers);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
await svc.from("units").delete().in("id", madeUnits);
await svc.from("vendor_properties").delete().in("vendor_id", madeVendors);
await svc.from("vendors").delete().in("id", madeVendors);
await svc.from("properties").delete().in("id", madeProps);
for (const id of [...madeNodes].reverse()) await svc.from("org_nodes").delete().eq("id", id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — you may only create someone below you, and only inside a region you hold."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
