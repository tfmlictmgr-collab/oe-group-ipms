// Verifies 0330:
//   • billing, activating, renewing and ending a tenancy is refused on a
//     property the caller does not manage, and works on one they do —
//     `leases_write`'s place clause, restated in the four DEFINER functions
//     that bypassed it;
//   • a tenancy's status cannot be moved by a direct write (PATCH or a live
//     INSERT) — only through the functions that keep the unit's occupant in
//     step with it;
//   • the daily expiry still runs with no signed-in caller, and by hand for an
//     administrator.
//   • and 0332's lease guard, at each status this suite reaches through its own
//     function: a signed-in caller removes (soft-deletes) only a draft, a
//     refused removal leaves the unit's occupant where it was, and the refusal
//     survives the app's cut at the first colon; an ended one is told it is
//     kept, not to End tenancy (0334). (verify-entry-corrections §F
//     covers 0332 on an active lease and a draft; this adds renewed, expired,
//     terminated and the occupant.)
//
// Every act runs in a signed-in user's own session inside ONE transaction that
// is rolled back at the end. That includes `expire_due_leases` over the real
// OEA org (decision 52 recorded a suite doing that for real); here it is undone.
//
// Usage: node scripts/verify-lease-transition-scope.mjs [--env .env.dev.local]
import path from "node:path";
import crypto from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile), quiet: true, override: true });
requireNonProductionTarget(process.cwd(), "Writes tenancy fixtures in a rolled-back transaction.");

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const check = (cond, m, detail) => (cond ? ok(m) : bad(detail ? `${m} — ${detail}` : m));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

async function as(uid) {
  await db.query("set local role authenticated");
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: uid, role: "authenticated" }),
  ]);
}
async function asOwner() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true)");
}
async function refused(sql, params) {
  await db.query("savepoint s");
  try {
    const r = await db.query(sql, params);
    await db.query("release savepoint s");
    refused.last = r;
    return null;
  } catch (e) {
    await db.query("rollback to savepoint s");
    return e.message;
  }
}
async function newUser(orgId, role, label) {
  const id = crypto.randomUUID();
  const email = `probe-leasescope-${label}-${id.slice(0, 8)}@oegroup.test`;
  await db.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
  await db.query("insert into users (id, org_id, role, full_name, email) values ($1, $2, $3, $4, $5)",
    [id, orgId, role, `Probe ${label}`, email]);
  return id;
}
const leaseRow = (id) => one("select status, unit_id, tenant_user_id from leases where id = $1", [id]);
const occupantOf = async (unitId) => (await one("select occupant_user_id from units where id = $1", [unitId])).occupant_user_id;
const flag = async () => (await one("select coalesce(current_setting('app.lease_transition', true), '') v")).v;

const NOT_MINE = /do not manage the property this tenancy is on/;
const STATUS_GUARD = /status changes only through Activate, Renew or End tenancy/;
const INSERT_GUARD = /recorded as a draft and made live with Activate/;
const NOT_REMOVED = /has been live is a record and cannot be deleted\. End it with End tenancy/;
const ENDED_KEPT = /has ended and is kept as part of the record/;
// What `failFromDb` shows: everything up to the first colon is cut (decision 52).
const shown = (m) => (m ?? "").replace(/^.*?:\s*/, "");

console.log(`\nLease transitions: place and path (0330), removal (0332) · ${envFile}`);
await db.connect();
await db.query("begin");

try {
  const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
  const byRole = (role) => one(
    `select id from users where org_id = $1 and role = $2 and deactivated_at is null
       and email like 'oea.%@oegroup.test' order by email limit 1`, [org.id, role]);
  const pm = await byRole("property_manager");
  const admin = await byRole("admin");
  if (!pm || !admin) throw new Error("demo accounts missing");

  // Two fresh properties: one staked to the PM, one not.
  await asOwner();
  const tag = crypto.randomBytes(3).toString("hex");
  const mine = await one("insert into properties (org_id, name, address) values ($1, $2, 'Probe Close') returning id",
    [org.id, `PROBE-LEASESCOPE-MINE-${tag}`]);
  const other = await one("insert into properties (org_id, name, address) values ($1, $2, 'Probe Close') returning id",
    [org.id, `PROBE-LEASESCOPE-OTHER-${tag}`]);
  const unit = async (propId, label) => (await one(
    "insert into units (org_id, property_id, label, apportionment_factor) values ($1, $2, $3, 100) returning id",
    [org.id, propId, label])).id;
  const [m1, m2, m3, m4] = [await unit(mine.id, "M1"), await unit(mine.id, "M2"), await unit(mine.id, "M3"), await unit(mine.id, "M4")];
  const [m5, m6] = [await unit(mine.id, "M5"), await unit(mine.id, "M6")];
  const [o1, o2] = [await unit(other.id, "O1"), await unit(other.id, "O2")];
  await db.query("insert into property_stakeholders (org_id, property_id, user_id, relation) values ($1, $2, $3, 'manager')",
    [org.id, mine.id, pm.id]);
  const tenant = await newUser(org.id, "tenant", "tenant");
  const tenant2 = await newUser(org.id, "tenant", "tenant2");

  // Leases on the property the PM does NOT manage, written as the system.
  const lease = async (propId, unitId, tenantId, status, start, end) => (await one(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency, status)
     values ($1, $2, $3, $4, current_date + $5::int, current_date + $6::int, 1000000, 'annual', $7) returning id`,
    [org.id, propId, unitId, tenantId, start, end, status])).id;
  const oDraft = await lease(other.id, o1, null, "draft", 0, 365);
  const oLive = await lease(other.id, o2, null, "active", -30, 335);

  section("0. Preconditions");
  await as(pm.id);
  const held = (await db.query("select current_user_property_ids() id")).rows.map((r) => r.id);
  check(held.includes(mine.id), "the PM manages the first probe property");
  check(!held.includes(other.id), "and does not manage the second", "the PM's scope reaches it — the refusals below would prove nothing");
  const perm = await one("select has_permission('leases.write') v");
  check(perm.v === true, "the PM holds leases.write, so only the place can refuse them");

  section("A. On a property they do not manage, every act is refused");
  let m = await refused("select activate_lease($1)", [oDraft]);
  check(NOT_MINE.test(m ?? ""), "activating a draft is refused", m);
  m = await refused("select raise_rent_charge($1, '2398-01-01', '2398-12-31', '2398-01-01')", [oLive]);
  check(NOT_MINE.test(m ?? ""), "billing rent is refused", m);
  m = await refused("select renew_lease($1, 12)", [oLive]);
  check(NOT_MINE.test(m ?? ""), "renewing is refused", m);
  m = await refused("select end_tenancy($1, 'probe: not my building')", [oLive]);
  check(NOT_MINE.test(m ?? ""), "ending is refused", m);
  await asOwner();
  check((await leaseRow(oDraft)).status === "draft" && (await leaseRow(oLive)).status === "active",
    "neither tenancy moved");
  check((await one("select count(*)::int n from rent_charges where lease_id = $1 and period_start = '2398-01-01'", [oLive])).n === 0,
    "and no demand was raised");

  section("B. A direct write cannot move a tenancy's status");
  await as(pm.id);
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, $4, current_date, current_date + 365, 1000000, 'annual') returning id`,
    [org.id, mine.id, m1, tenant]);
  check(m === null, "the PM records a draft tenancy on their own property", m);
  const mDraft = refused.last.rows[0].id;
  m = await refused("update leases set status = 'active' where id = $1 returning id", [mDraft]);
  check(STATUS_GUARD.test(m ?? ""), "PATCHing a draft to active is refused", m);
  check((await occupantOf(m1)) === null, "the unit has no occupant — nothing half-happened");
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency, status)
     values ($1, $2, $3, $4, current_date, current_date + 365, 1000000, 'annual', 'active') returning id`,
    [org.id, mine.id, m2, tenant2]);
  check(INSERT_GUARD.test(m ?? ""), "INSERTing a tenancy straight in as active is refused", m);
  await db.query("select set_config('app.lease_transition', $1, true)", [oLive]);
  m = await refused("update leases set status = 'active' where id = $1", [mDraft]);
  check(STATUS_GUARD.test(m ?? ""), "a flag naming another tenancy does not open this one", m);
  await db.query("select set_config('app.lease_transition', $1, true)", [`expire:${org.id}`]);
  m = await refused("update leases set status = 'active' where id = $1", [mDraft]);
  check(STATUS_GUARD.test(m ?? ""), "the expiry flag admits only a move to expired", m);
  await db.query("select set_config('app.lease_transition', '', true)");

  section("C. On a property they manage, each act goes through its own function");
  m = await refused("select activate_lease($1)", [mDraft]);
  check(m === null, "the PM activates the draft", m);
  check((await leaseRow(mDraft)).status === "active", "it is live");
  check((await occupantOf(m1)) === tenant, "and the unit's occupant is its tenant");
  check((await flag()) === "", "the transition flag does not outlive the function");
  m = await refused("update leases set status = 'terminated' where id = $1", [mDraft]);
  check(STATUS_GUARD.test(m ?? ""), "PATCHing a live tenancy to terminated is refused", m);
  m = await refused("select raise_rent_charge($1, '2398-01-01', '2398-12-31', '2398-01-01') id", [mDraft]);
  check(m === null && Boolean(refused.last.rows[0].id), "the PM bills rent on it", m);
  m = await refused("select renew_lease($1, 12) id", [mDraft]);
  check(m === null, "the PM renews it", m);
  const successor = refused.last?.rows?.[0]?.id;
  await asOwner();
  const s = successor ? await one("select status, renewed_from_lease_id from leases where id = $1", [successor]) : null;
  check((await leaseRow(mDraft)).status === "renewed" && s?.status === "active" && s?.renewed_from_lease_id === mDraft,
    "the old term is renewed and its successor is born live", JSON.stringify(s));
  await as(pm.id);
  check((await flag()) === "", "the flag is cleared after the renewal too");
  m = await refused("select end_tenancy($1, 'probe: tenant gave notice early')", [successor]);
  check(m === null, "the PM ends the successor", m);
  await asOwner();
  check((await leaseRow(successor)).status === "terminated", "it is terminated (it had not reached its end date)");
  check((await occupantOf(m1)) === null, "and the unit's occupant is cleared with it");

  section("D. The expiry sweep");
  const due1 = await lease(mine.id, m3, null, "active", -400, -1);
  await as(admin.id);
  m = await refused("select expire_due_leases($1) n", [org.id]);
  check(m === null && Number(refused.last.rows[0].n) >= 1, "an administrator runs it by hand", m);
  await asOwner();
  check((await leaseRow(due1)).status === "expired", "the overdue tenancy is expired");
  check((await leaseRow(oLive)).status === "active", "a tenancy still in term is not touched");
  const due2 = await lease(mine.id, m4, null, "active", -400, -1);
  m = await refused("select expire_due_leases($1) n", [org.id]);
  check(m === null && Number(refused.last.rows[0].n) >= 1, "the daily job (no signed-in caller) still runs", m);
  check((await leaseRow(due2)).status === "expired", "and expires what is due");
  await as(pm.id);
  m = await refused("select expire_due_leases($1)", [org.id]);
  check(/only an administrator/.test(m ?? ""), "a property manager still may not run it by hand", m);

  // Every status here was reached through its own function above, never by a
  // write to `status`: mDraft is renewed, successor terminated, due1 expired.
  section("E. A tenancy that has been live is not removed, at any status (0332)");
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, $4, current_date, current_date + 365, 1000000, 'annual') returning id`,
    [org.id, mine.id, m5, tenant2]);
  check(m === null, "the PM records a second tenancy", m);
  const live = refused.last.rows[0].id;
  m = await refused("select activate_lease($1)", [live]);
  check(m === null && (await occupantOf(m5)) === tenant2, "and activates it, making its tenant the occupant", m);
  m = await refused("update leases set deleted_at = now() where id = $1", [live]);
  check(NOT_REMOVED.test(m ?? ""), "removing an active tenancy is refused, naming End tenancy", m);
  check(m !== null && shown(m) === m, "the refusal survives the app's cut at the first colon", shown(m));
  check((await one("select id from leases where id = $1", [live]))?.id === live, "the tenancy is still listed to the PM");
  await asOwner();
  const u5 = await one("select occupant_user_id, deleted_at from units where id = $1", [m5]);
  check(u5.occupant_user_id === tenant2 && u5.deleted_at === null, "the unit's occupant is unchanged");
  check((await leaseRow(live)).status === "active", "and the tenancy is still active");
  await as(pm.id);
  m = await refused("update leases set deleted_at = now(), notes = 'tidying up' where id = $1", [live]);
  check(NOT_REMOVED.test(m ?? ""), "removing it alongside another column is refused too", m);
  m = await refused("update leases set deleted_at = now() where id = $1", [mDraft]);
  check(NOT_REMOVED.test(m ?? ""), "removing a renewed tenancy is refused", m);
  m = await refused("update leases set deleted_at = now() where id = $1", [due1]);
  check(ENDED_KEPT.test(m ?? ""), "removing an expired tenancy is refused, naming no remedy it cannot use (0334)", m);
  m = await refused("update leases set deleted_at = now() where id = $1", [successor]);
  check(ENDED_KEPT.test(m ?? ""), "removing a terminated tenancy is refused the same way", m);
  check(m !== null && shown(m) === m, "that refusal survives the cut too", shown(m));
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, tenant_name, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, null, 'Probe Company Ltd', current_date, current_date + 365, 1000000, 'annual') returning id`,
    [org.id, mine.id, m6]);
  check(m === null, "the PM records a draft company let", m);
  const draft = m === null ? refused.last.rows[0].id : null;
  m = await refused("update leases set deleted_at = now() where id = $1", [draft]);
  check(m === null && refused.last.rowCount === 1, "a draft may still be removed by the PM", m);
  // Not "the PM can no longer read it": `leases_write` (0090) is FOR ALL, so its
  // USING also admits SELECT, and the letting desk still reads its own
  // property's removed rows. The lists filter `deleted_at` themselves.
  await asOwner();
  check((await one("select deleted_at from leases where id = $1", [draft]))?.deleted_at !== null,
    "and it is marked removed");
  await as(pm.id);
  m = await refused("update leases set notes = 'probe note' where id = $1", [live]);
  check(m === null && refused.last.rowCount === 1, "other writes to a live tenancy are not this guard's concern", m);
  await asOwner();
  m = await refused("update leases set deleted_at = now() where id = $1", [due2]);
  check(m === null && refused.last.rowCount === 1, "a session with no signed-in caller is not this guard's subject", m);
  const g = await one(
    `select has_function_privilege('authenticated', 'guard_lease_soft_delete()', 'EXECUTE') a,
            has_function_privilege('anon', 'guard_lease_soft_delete()', 'EXECUTE') b`);
  check(!g.a && !g.b, "the removal guard is not executable by a client role");
  await as(pm.id);
  m = await refused("update leases set deleted_at = null where id = $1", [due2]);
  check(/cannot be restored/.test(m ?? "") || (m === null && refused.last.rowCount === 0),
    "a signed-in caller cannot revive it", m);
  await asOwner();
  check((await one("select deleted_at from leases where id = $1", [due2])).deleted_at !== null, "and it stays removed");
} catch (e) {
  bad(`unexpected: ${e.message}`);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

if (failures > 0) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mALL CHECKS PASSED — a tenancy is billed, activated, renewed and ended only on a building the caller manages, its status moves only through those functions, and only a draft is removed.\x1b[0m");
