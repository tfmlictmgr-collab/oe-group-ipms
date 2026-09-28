// A request is told to whoever can act on it, and the administrator steps in
// only once it has been left — 0304.
//
// The operator's rule (27 Sept 2026, found in self-assessment B4):
//   1. a new request alerts ONLY the people who can open it and act on it —
//      the manager of its property, or, with no property, whoever triages
//      those; never every FM/PM in the organisation, never the administrator;
//   2. the administrator sees and opens every request but ACTS on one only
//      once it has gone 24 hours without action, or 24 hours with nobody
//      assigned.
//
// Every refusal is proven by ATTEMPTING the write as a real signed-in user.
// Every section runs inside a transaction that is ROLLED BACK, so the suite
// leaves no request, notification or escalation behind in the world it is
// pointed at — and never spends a real administrator's one-time notice.
//
// Usage: node scripts/verify-request-alert-audience.mjs
import { config } from "dotenv";
import { requireNonProductionTarget } from "./lib/target-env.mjs";
import pg from "pg";

config({ path: ".env.local", quiet: true });
requireNonProductionTarget(process.cwd(), "Writes (and rolls back) fixture requests as real users.");

if (!process.env.SUPABASE_DB_HOST) {
  console.error("Missing SUPABASE_DB_* in .env.local");
  process.exit(2);
}

const client = new pg.Client({
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
const check = (cond, m) => (cond ? ok(m) : bad(m));
const q1 = async (sql, params) => (await client.query(sql, params)).rows[0];

/** One section = one transaction, always rolled back. */
async function section(title, fn) {
  console.log(`\n${title}`);
  await client.query("begin");
  try {
    await fn();
  } catch (e) {
    bad(`the section stopped: ${e.message}`);
  } finally {
    await client.query("rollback");
  }
}

/**
 * Run one statement as `uid`. `{ ok, rowCount, error }`. A refusal is rolled
 * back to a savepoint so the section carries on; a success is kept for the
 * checks that follow, and the caller's identity is dropped either way.
 */
async function as(uid, sql, params) {
  await client.query("savepoint act");
  try {
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: uid, role: "authenticated" })]);
    const r = await client.query(sql, params);
    await client.query("reset role");
    await client.query(`select set_config('request.jwt.claims', '', true)`);
    await client.query("release savepoint act");
    return { ok: r.rowCount > 0, rowCount: r.rowCount, error: r.rowCount > 0 ? null : "no rows updated" };
  } catch (e) {
    await client.query("rollback to savepoint act");
    return { ok: false, rowCount: 0, error: e.message };
  }
}

await client.connect();
try {
  // ── Fixtures: an organisation with an administrator and a manager who
  //    manages a property directly. Chosen, not created, so the suite reads
  //    the world's real permission matrix.
  const org = await q1(`
    select o.id, o.name
      from orgs o
     where o.deleted_at is null and not o.is_platform_operator
       and exists (select 1 from users u where u.org_id = o.id and u.role = 'admin' and u.deactivated_at is null)
       and exists (select 1 from property_stakeholders s join users u on u.id = s.user_id
                    where s.org_id = o.id and s.property_id is not null and u.deactivated_at is null
                      and u.role in ('facility_manager', 'property_manager'))
       and exists (select 1 from vendors v where v.org_id = o.id)
     order by o.name limit 1`);
  if (!org) { console.error("need an org with an admin, a manager on a property, and a vendor"); process.exit(2); }

  const pick = async (role) =>
    (await q1(`select id from users where org_id = $1 and role = $2 and deactivated_at is null
                 and sign_in_locked_at is null order by created_at limit 1`, [org.id, role]))?.id ?? null;

  const admin = await pick("admin");
  const mgr = await q1(`
    select u.id, s.property_id
      from property_stakeholders s join users u on u.id = s.user_id
     where s.org_id = $1 and s.property_id is not null and u.deactivated_at is null
       and u.sign_in_locked_at is null and u.role in ('facility_manager', 'property_manager')
     order by u.created_at limit 1`, [org.id]);
  const other = (await q1(`
    select u.id from users u
     where u.org_id = $1 and u.role in ('facility_manager', 'property_manager')
       and u.deactivated_at is null and u.id <> $2
       and not ($3::uuid in (select user_property_ids(u.id)))
     limit 1`, [org.id, mgr.id, mgr.property_id]))?.id ?? null;
  const vendor = (await q1(`select id from vendors where org_id = $1 limit 1`, [org.id])).id;
  const triagers = (await client.query(`
    select u.id from users u
     where u.org_id = $1 and u.role = any (fm_roles()) and u.role <> 'admin'
       and u.deactivated_at is null and u.sign_in_locked_at is null and u.email_released_at is null
       and exists (select 1 from role_permissions rp where rp.org_id = u.org_id and rp.role = u.role
                     and rp.capability = 'tickets.assign' and rp.granted)
       and exists (select 1 from role_permissions rp where rp.org_id = u.org_id and rp.role = u.role
                     and rp.capability = 'tickets.triage_unassigned' and rp.granted)`, [org.id])).rows.map((r) => r.id);

  console.log(`Requests reach whoever can act on them (0304) — org "${org.name}"`);

  /** A request as the service role writes one: an inbound, not a person. */
  const mk = async ({ property = null, hoursOld = 0, quietHours = null, vendorId = null,
                      status = "open", reviewed = false, sender = null } = {}) =>
    (await q1(`
      insert into tickets (org_id, channel, message_text, category, urgency, status, property_id,
                           assigned_vendor_id, sender_id, created_at, last_acted_at, reviewed_at,
                           assigned_at)
      values ($1, 'portal', 'Probe 0304 fixture', 'maintenance', 'normal', $2::ticket_status, $3,
              $4, $5, now() - ($6 || ' hours')::interval,
              now() - (coalesce($7, $6) || ' hours')::interval,
              case when $8 then now() - ($6 || ' hours')::interval end,
              case when $4::uuid is not null then now() - ($6 || ' hours')::interval end)
      returning id`,
      [org.id, status, property, vendorId, sender, String(hoursOld),
       quietHours === null ? null : String(quietHours), reviewed])).id;

  const audience = async (id) =>
    (await client.query(`select user_id from ticket_alert_audience($1)`, [id])).rows.map((r) => r.user_id);

  // ─────────────────────────────────────────────────────────────────────────
  await section("1. A request on a property reaches its manager — and only its manager", async () => {
    const t = await mk({ property: mgr.property_id });
    const who = await audience(t);
    check(who.includes(mgr.id), "the property's own manager is in the audience");
    check(!who.includes(admin), "the administrator is not");
    if (other) check(!who.includes(other), "a manager of OTHER buildings is not");
    else console.log("  (skipped: no second manager to prove the negative with)");

    const sent = (await client.query(
      `select user_id, fallback from notify_ticket_audience($1, 'request', 'New normal request — probe', 'Probe body', $2)`,
      [t, `/dashboard/tickets/${t}`])).rows;
    check(sent.length === who.length && sent.every((r) => r.fallback === false),
      `notify_ticket_audience told exactly that audience (${sent.length}), no fallback`);
    const bell = (await client.query(`select user_id from user_notifications where entity_id = $1`, [t])).rows.map((r) => r.user_id);
    check(bell.includes(mgr.id) && !bell.includes(admin) && (!other || !bell.includes(other)),
      "the bell rang for the manager, not for the administrator or other managers");
  });

  await section("2. A request with no property reaches whoever triages those", async () => {
    const t = await mk({ property: null });
    const who = await audience(t);
    check(!who.includes(admin), "the administrator is not in the audience");
    check(!who.includes(mgr.id) || triagers.includes(mgr.id), "a property manager without triage authority is not");
    check(who.length === triagers.length && triagers.every((id) => who.includes(id)),
      `exactly the ${triagers.length} triaging role-holder(s) are`);
    const sent = (await client.query(
      `select user_id, fallback from notify_ticket_audience($1, 'request', 'New normal request — probe', null, $2)`,
      [t, `/dashboard/tickets/${t}`])).rows;
    if (triagers.length > 0) {
      check(sent.every((r) => !r.fallback), "…and they are told, with no fallback");
    } else {
      check(sent.length > 0 && sent.every((r) => r.fallback),
        "nobody triages here, so the administrators are told instead");
    }
  });

  await section("3. Nobody can open it: the administrators are told at once, and why", async () => {
    const p = (await q1(`insert into properties (org_id, name) values ($1, 'Probe 0304 — no manager') returning id`, [org.id])).id;
    const t = await mk({ property: p });
    check((await audience(t)).length === 0, "a property with no manager has no operational audience");
    const sent = (await client.query(
      `select user_id, fallback from notify_ticket_audience($1, 'request', 'New normal request — probe', null, $2)`,
      [t, `/dashboard/tickets/${t}`])).rows;
    check(sent.length > 0 && sent.every((r) => r.fallback), "the administrators are told instead (fallback)");
    const n = await q1(`select title, body from user_notifications where entity_id = $1 and user_id = $2`, [t, admin]);
    check(/no manager covers it/.test(n?.title ?? "") && /24 hours/.test(n?.body ?? ""),
      "and the notice says no manager covers it and when they may act");
  });

  // ─────────────────────────────────────────────────────────────────────────
  await section("4. The administrator cannot act on a fresh request", async () => {
    const t = await mk({ property: mgr.property_id, hoursOld: 1 });
    const review = await as(admin, `update tickets set reviewed_at = now(), reviewed_by = $2 where id = $1`, [t, admin]);
    check(!review.ok && /with its manager/.test(review.error ?? ""), `review refused (${(review.error ?? "").slice(0, 60)}…)`);
    const status = await as(admin, `update tickets set status = 'closed' where id = $1`, [t]);
    check(!status.ok && /with its manager/.test(status.error ?? ""), "closing it refused");
    const dispatch = await as(admin, `update tickets set assigned_vendor_id = $2, status = 'assigned' where id = $1`, [t, vendor]);
    check(!dispatch.ok, "dispatching it refused");
    check(/Lagos time/.test(review.error ?? ""), "the refusal says from when they may act");
  });

  await section("5. The desk acts, and the clock moves; the administrator's acts do not move it", async () => {
    const t = await mk({ property: mgr.property_id, hoursOld: 30, quietHours: 30 });
    const r = await as(mgr.id, `update tickets set reviewed_at = now(), reviewed_by = $2 where id = $1`, [t, mgr.id]);
    check(r.ok, "the manager reviews it");
    const after = await q1(`select last_acted_at > now() - interval '1 minute' as fresh from tickets where id = $1`, [t]);
    check(after.fresh, "…and last_acted_at moves to now");

    const t2 = await mk({ property: mgr.property_id, hoursOld: 40, quietHours: 40 });
    const a = await as(admin, `update tickets set urgency = 'high' where id = $1`, [t2]);
    check(a.ok, "the administrator acts on a request left 40 hours");
    const still = await q1(`select last_acted_at < now() - interval '39 hours' as quiet from tickets where id = $1`, [t2]);
    check(still.quiet, "…and their own act does not reset the desk's clock");
  });

  await section("6. 24 hours with nobody assigned: the administrator may act", async () => {
    const t = await mk({ property: mgr.property_id, hoursOld: 30, quietHours: 30 });
    const d = await as(admin, `update tickets set assigned_vendor_id = $2, status = 'assigned' where id = $1`, [t, vendor]);
    check(d.ok, "an administrator dispatches a request unassigned for 30 hours");
    const row = await q1(`select reviewed_by from tickets where id = $1`, [t]);
    check(row.reviewed_by === admin, "…recorded as the reviewer, as 0212's rescue requires");

    const t2 = await mk({ property: mgr.property_id, hoursOld: 30, quietHours: 30, reviewed: true });
    const d2 = await as(admin, `update tickets set assigned_vendor_id = $2, status = 'assigned' where id = $1`, [t2, vendor]);
    check(d2.ok, "…and one the manager reviewed long ago but never dispatched");
  });

  await section("7. Assigned, but left: the administrator may act; assigned and moving: they may not", async () => {
    const idle = await mk({ property: mgr.property_id, hoursOld: 50, quietHours: 30, vendorId: vendor, status: "assigned", reviewed: true });
    const a = await as(admin, `update tickets set status = 'in_progress' where id = $1`, [idle]);
    check(a.ok, "a request assigned 50 hours ago with no action for 30 — the administrator may act");

    const busy = await mk({ property: mgr.property_id, hoursOld: 50, quietHours: 2, vendorId: vendor, status: "assigned", reviewed: true });
    const b = await as(admin, `update tickets set assigned_vendor_id = null, status = 'open' where id = $1`, [busy]);
    check(!b.ok && /with its manager/.test(b.error ?? ""),
      "a request 50 hours old but acted on 2 hours ago — refused; the desk has it");
  });

  await section("8. An administrator who reported a request may correct its urgency, and nothing else", async () => {
    const t = await mk({ property: mgr.property_id, hoursOld: 1, sender: admin });
    const u = await as(admin, `update tickets set urgency = 'high', urgency_source = 'reporter', urgency_changed_at = now() where id = $1`, [t]);
    check(u.ok, "their own urgency correction goes through");
    const s = await as(admin, `update tickets set status = 'closed' where id = $1`, [t]);
    check(!s.ok, "but closing their own fresh request is still the desk's call");
  });

  await section("9. The administrators are told about left work once per idle spell", async () => {
    const t = await mk({ property: mgr.property_id, hoursOld: 50, quietHours: 30, vendorId: vendor, status: "assigned", reviewed: true });
    const first = await q1(`select escalate_idle_requests() as n`);
    const told = await q1(`select count(*)::int as n from user_notifications where entity_id = $1 and user_id = $2`, [t, admin]);
    check(first.n > 0 && told.n === 1, "the hourly job tells the administrator about it");
    const again = await q1(`select escalate_idle_requests() as n`);
    const told2 = await q1(`select count(*)::int as n from user_notifications where entity_id = $1 and user_id = $2`, [t, admin]);
    check(Number(again.n) === 0 && told2.n === 1, "…once: a second run says nothing new");

    // The desk acts, then goes quiet again: a new spell, told again.
    await client.query(
      `update tickets set idle_escalated_at = now() - interval '30 hours',
                          last_acted_at     = now() - interval '25 hours' where id = $1`, [t]);
    await q1(`select escalate_idle_requests() as n`);
    const told3 = await q1(`select count(*)::int as n from user_notifications where entity_id = $1 and user_id = $2`, [t, admin]);
    check(told3.n === 2, "after the desk acts and goes quiet again, they are told again");

    const fresh = await mk({ property: mgr.property_id, hoursOld: 1 });
    await q1(`select escalate_idle_requests() as n`);
    const none = await q1(`select count(*)::int as n from user_notifications where entity_id = $1`, [fresh]);
    check(none.n === 0, "a fresh request is not escalated");
  });

  await section("10. Nobody signed in can call the service-only functions", async () => {
    const t = await mk({ property: mgr.property_id });
    for (const [fn, sql] of [
      ["ticket_alert_audience", `select * from ticket_alert_audience('${t}')`],
      ["notify_ticket_audience", `select * from notify_ticket_audience('${t}', 'request', 'x', null, null)`],
      ["user_property_ids", `select * from user_property_ids('${mgr.id}')`],
      ["escalate_idle_requests", `select escalate_idle_requests()`],
    ]) {
      const r = await as(admin, sql);
      check(!r.ok && /permission denied|runs unattended|not a signed-in user/.test(r.error ?? ""),
        `${fn} is refused to a signed-in administrator`);
    }
  });
} finally {
  await client.end();
}

console.log(failures === 0
  ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a request reaches whoever can act on it, and the administrator only work that has been left.\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
