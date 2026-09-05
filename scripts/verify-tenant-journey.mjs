// The tenant/resident's documented journey, across every organisation:
//   report an issue → AI triage (category, priority, and the exchange about it)
//   → ticket + acknowledgement → track it → pay the service charge → see the
//   statement and what they have paid → appraise the vendor.
//
// Three of those were broken in ways only this role could hit:
//
//   * The portal never triaged. WhatsApp and Telegram classify every message;
//     the web form — the system of record — took the category and the SEVERITY
//     from two dropdowns the reporter filled in, wrote the row from the
//     browser, showed no reference back, and told nobody.
//   * A tenant could not pay a service charge at all. `payment_intents_insert`
//     admits admin/finance/FM and nobody else, so the person being billed had
//     a number and no button.
//   * ⚠️ And a service-charge payment never settled the invoice. The line
//     `update service_charges set status = 'paid'` lived in record_collection
//     from 0032 to 0049 and did not survive the 0092 rewrite. Section E is the
//     regression guard: the money reached the ledger and the invoice stayed
//     open for ever.
//
// Section H is a separate finding, guarded here because this journey is what
// found it: `notify_role` took the target org as an ARGUMENT and never checked
// it, so any signed-in user could write into another brand's inbox.
//
// Usage: node scripts/verify-tenant-journey.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await db.connect();

const claims = (id) =>
  `set local request.jwt.claims = '${JSON.stringify({ sub: id, role: "authenticated" }).replace(/'/g, "''")}'`;

/** One statement as a user, rolled back. */
async function tryAs(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(claims(userId));
    const r = await db.query(sql);
    await db.query("rollback");
    return { ok: true, rows: r.rows, n: r.rowCount };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 110) };
  }
}

/**
 * Several statements in ONE transaction, rolled back.
 *
 * ⚠️ Separate statements, never a CTE. A row created inside a CTE is not
 * visible to a SELECT in the same statement — both are evaluated against the
 * snapshot taken at statement start — and an earlier suite reported "created
 * but unreadable to its creator" on every org because of it: a test artefact
 * that read exactly like the product bug it was written to catch.
 *
 * `steps` may mix roles: pass `{ as: id, sql }` to switch who is speaking
 * mid-transaction, which is what a payment needs (the tenant opens it; the
 * webhook settles it as service_role).
 */
async function steps(userId, items) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(claims(userId));
    const out = [];
    for (const item of items) {
      if (typeof item === "object" && item.service) {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
      } else if (typeof item === "object" && item.as) {
        await db.query("set local role authenticated");
        await db.query(claims(item.as));
      }
      const sql = typeof item === "string" ? item : item.sql;
      if (sql) out.push((await db.query(sql)).rows);
    }
    await db.query("rollback");
    return { ok: true, steps: out };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 140) };
  }
}

const { data: orgs } = await svc.from("orgs")
  .select("id, name, slug, is_platform_operator").is("deleted_at", null).order("slug");
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

console.log("Tenant/resident journey — every step, every organisation\n");

for (const o of tenantOrgs) {
  const { data: tenants } = await svc.from("users").select("id, email")
    .eq("org_id", o.id).eq("role", "tenant").is("deactivated_at", null).limit(2);
  const me = (tenants ?? [])[0];
  if (!me) { note(`${o.slug}: no tenant user — skipped`); continue; }

  console.log(`── ${o.slug} ──`);

  // ── A. Report an issue ──────────────────────────────────────────────────
  //
  // The portal writes as the reporter, under RLS — the classification happens
  // in the application layer, but the ROW it produces has to be one this user
  // is allowed to create and then read back.
  const raised = await steps(me.id, [
    `create temp table _t (id uuid) on commit drop`,
    `with _n as (insert into tickets (org_id, sender_id, channel, message_text, category, urgency,
                            summary, requires_human_review, classified_by)
       values ('${o.id}', '${me.id}', 'portal', 'PROBETENANT the lift is stuck between floors',
               'maintenance', 'high', 'Lift stuck between floors', true, 'anthropic')
       returning id) insert into _t select id from _n`,
    `select t.id, t.sender_id, t.urgency::text, t.classified_by
       from tickets t where t.id = (select id from _t)`,
  ]);
  const row = raised.ok ? raised.steps[2][0] : undefined;
  row?.sender_id === me.id
    ? ok("raises a request and reads it straight back")
    : bad(`could not raise a request: ${raised.err ?? "unreadable to its creator"}`);
  row?.classified_by === "anthropic"
    ? ok("with the classifier that judged it recorded on the row")
    : bad(`classified_by not recorded: ${JSON.stringify(row)}`);

  // ── B. The exchange about priority ──────────────────────────────────────
  //
  // What the chat channels have had since 0075 and the portal had not.
  const corrected = await steps(me.id, [
    `create temp table _t2 (id uuid) on commit drop`,
    `with _n as (insert into tickets (org_id, sender_id, channel, message_text, category, urgency, summary)
       values ('${o.id}', '${me.id}', 'portal', 'PROBETENANT no water since Tuesday',
               'maintenance', 'normal', 'No water') returning id) insert into _t2 select id from _n`,
    `select set_my_ticket_urgency((select id from _t2), 'critical') as applied`,
    `select urgency::text, urgency_source, requires_human_review
       from tickets where id = (select id from _t2)`,
  ]);
  const after = corrected.ok ? corrected.steps[3][0] : undefined;
  corrected.ok && corrected.steps[2][0]?.applied === true
    ? ok("corrects the priority on their OWN request")
    : bad(`could not correct their own priority: ${corrected.err ?? "not applied"}`);
  after?.urgency === "critical" && after?.urgency_source === "reporter"
    ? ok("recorded as the reporter's judgement, not staff's")
    : bad(`wrong urgency/source: ${JSON.stringify(after)}`);
  after?.requires_human_review === true
    ? ok("and raised for a person to look at — someone saying it is worse is exactly that case")
    : bad("escalating to critical did not flag it for human review");

  // Somebody else's request is not theirs to re-prioritise. The risk is not
  // vandalism; it is that a reference number is guessable and a priority is
  // how work gets ordered.
  const { data: other } = await svc.from("tickets")
    .select("id").eq("org_id", o.id).neq("sender_id", me.id).limit(1).maybeSingle();
  if (other) {
    const cross = await tryAs(me.id, `select set_my_ticket_urgency('${other.id}', 'critical') as applied`);
    cross.ok && cross.rows[0]?.applied === false
      ? ok("cannot re-prioritise a request they did not raise")
      : bad("!!! A TENANT RE-PRIORITISED SOMEONE ELSE'S REQUEST");
  } else {
    note("no other reporter's ticket on this org — cross-reporter check not run");
  }

  // A staff decision stands. Their opinion is recorded as a message instead.
  const staffSet = await steps(me.id, [
    `create temp table _t3 (id uuid) on commit drop`,
    `with _n as (insert into tickets (org_id, sender_id, channel, message_text, category, urgency,
                            summary, urgency_source)
       values ('${o.id}', '${me.id}', 'portal', 'PROBETENANT dripping tap', 'maintenance',
               'low', 'Dripping tap', 'staff') returning id) insert into _t3 select id from _n`,
    `select set_my_ticket_urgency((select id from _t3), 'critical') as applied`,
    `select urgency::text from tickets where id = (select id from _t3)`,
  ]);
  staffSet.ok && staffSet.steps[2][0]?.applied === false && staffSet.steps[3][0]?.urgency === "low"
    ? ok("and cannot overwrite a priority an operator set deliberately")
    : bad(`a staff-set priority was overwritten: ${staffSet.err ?? JSON.stringify(staffSet.steps?.[3]?.[0])}`);

  // ── C. Track it ─────────────────────────────────────────────────────────
  const tracked = await tryAs(me.id, `select count(*)::int n from my_requests()`);
  tracked.ok
    ? ok(`tracks ${tracked.rows[0].n} request(s) with their timeline`)
    : bad(`cannot read their own request tracker: ${tracked.err}`);

  // ── D. Pay the service charge ───────────────────────────────────────────
  const mine = await tryAs(me.id, `select count(*)::int n from my_service_charges()`);
  mine.ok
    ? ok(`sees ${mine.rows[0].n} service-charge invoice(s) of their own`)
    : bad(`cannot read their own statement: ${mine.err}`);

  // ⚠️ Every invoice below is created as SERVICE ROLE, not as the tenant.
  //
  // The first version of this suite issued them as the tenant and read the
  // resulting "new row violates row-level security policy" as a failure of the
  // payment path. It was nothing of the kind: `service_charges_insert` admits
  // staff only, and a tenant who could issue their own invoice would be a far
  // worse defect than the one being tested. The fixture was wrong, not the
  // product — so the invoice is raised the way finance raises it, and only the
  // PAYING is done as the tenant.
  const paid = await steps(me.id, [
    `create temp table _sc (id uuid) on commit drop`,
    { service: true, sql:
      `with _n as (insert into service_charges (org_id, billed_to_user_id, property_or_unit,
                                    billing_period, amount, status, due_date)
       values ('${o.id}', '${me.id}', 'PROBETENANT Unit 1', '2026', 400000, 'invoiced',
               current_date + 30) returning id) insert into _sc select id from _n` },
    { as: me.id, sql: `select create_service_charge_payment_intent((select id from _sc)) as intent_id` },
    `select amount_expected, payer_user_id, purpose::text, status::text
       from payment_intents where service_charge_id = (select id from _sc)`,
  ]);
  const intent = paid.ok ? paid.steps[3][0] : undefined;
  paid.ok && paid.steps[2][0]?.intent_id
    ? ok("OPENS A PAYMENT for their own invoice — the button that did not exist")
    : bad(`cannot pay their own service charge: ${paid.err}`);
  Number(intent?.amount_expected) === 400000 && intent?.payer_user_id === me.id
    ? ok("for the amount on the invoice, billed to them — never a figure the browser sent")
    : bad(`wrong intent shape: ${JSON.stringify(intent)}`);

  // Two live links for one debt is how a payer pays twice.
  const twice = await steps(me.id, [
    `create temp table _sc2 (id uuid) on commit drop`,
    { service: true, sql:
      `with _n as (insert into service_charges (org_id, billed_to_user_id, property_or_unit,
                                    billing_period, amount, status)
       values ('${o.id}', '${me.id}', 'PROBETENANT Unit 2', '2026', 250000, 'invoiced')
       returning id) insert into _sc2 select id from _n` },
    { as: me.id, sql: `select create_service_charge_payment_intent((select id from _sc2)) as a` },
    `select create_service_charge_payment_intent((select id from _sc2)) as b`,
  ]);
  !twice.ok && /already open/i.test(twice.err ?? "")
    ? ok("and a second live checkout on the same invoice is refused")
    : bad(`a second live checkout was allowed: ${twice.err ?? "no refusal"}`);

  // ⚠️ The sharp one. Opening an intent on someone else's invoice does not
  // just pay their bill — it LOCKS THEM OUT of paying it, via the guard above,
  // from any account in the org. Same defect 0110 found in the rent function.
  const victim = (tenants ?? [])[1];
  if (victim) {
    const lockout = await steps(victim.id, [
      `create temp table _sc3 (id uuid) on commit drop`,
      { service: true, sql:
        `with _n as (insert into service_charges (org_id, billed_to_user_id, property_or_unit,
                                      billing_period, amount, status)
         values ('${o.id}', '${victim.id}', 'PROBETENANT Unit 3', '2026', 90000, 'invoiced')
         returning id) insert into _sc3 select id from _n` },
      { as: me.id, sql: `select create_service_charge_payment_intent((select id from _sc3)) as id` },
    ]);
    !lockout.ok && /billed to someone else/i.test(lockout.err ?? "")
      ? ok("cannot open a checkout against another tenant's invoice — no lock-out")
      : bad(`opened a payment on another tenant's invoice: ${lockout.err ?? "allowed"}`);
  } else {
    note("only one tenant on this org — the lock-out check needs two");
  }

  // ── E. A payment must settle the invoice ────────────────────────────────
  //
  // ⚠️ The regression guard. The ledger posting was never the broken part.
  const settled = await steps(me.id, [
    `create temp table _sc4 (id uuid) on commit drop`,
    { service: true, sql:
      `with _n as (insert into service_charges (org_id, billed_to_user_id, property_or_unit,
                                    billing_period, amount, status)
       values ('${o.id}', '${me.id}', 'PROBETENANT Unit 4', '2026', 100000, 'invoiced')
       returning id) insert into _sc4 select id from _n` },
    { as: me.id, sql: `create temp table _pi on commit drop as
       select create_service_charge_payment_intent((select id from _sc4)) as id` },
    { service: true, sql: `select record_collection((select id from _pi), 100000) as entry` },
    { as: me.id, sql: `select status, amount_paid from service_charges where id = (select id from _sc4)` },
  ]);
  const sc = settled.ok ? settled.steps[4][0] : undefined;
  sc?.status === "paid" && Number(sc?.amount_paid) === 100000
    ? ok("PAYING IN FULL marks the invoice paid — the line lost in the 0092 rewrite")
    : bad(`!!! paid in full and the invoice still reads ${sc?.status ?? settled.err}`);

  const part = await steps(me.id, [
    `create temp table _sc5 (id uuid) on commit drop`,
    { service: true, sql:
      `with _n as (insert into service_charges (org_id, billed_to_user_id, property_or_unit,
                                    billing_period, amount, status)
       values ('${o.id}', '${me.id}', 'PROBETENANT Unit 5', '2026', 100000, 'invoiced')
       returning id) insert into _sc5 select id from _n` },
    { as: me.id, sql: `create temp table _pi5 on commit drop as
       select create_service_charge_payment_intent((select id from _sc5)) as id` },
    { service: true, sql: `select record_collection((select id from _pi5), 30000) as entry` },
    { as: me.id, sql: `select status, amount_paid from service_charges where id = (select id from _sc5)` },
    // And the balance must still be collectable. The old index blocked a second
    // intent while a `part_paid` one existed, so a short payment made the rest
    // unpayable by ANY route, including finance's.
    `select create_service_charge_payment_intent((select id from _sc5)) as id`,
    `select amount_expected from payment_intents
      where service_charge_id = (select id from _sc5) and status = 'pending'`,
  ]);
  const p = part.ok ? part.steps[4][0] : undefined;
  p?.status === "part_paid" && Number(p?.amount_paid) === 30000
    ? ok("paying PART marks it part paid, not paid — a short payment is not a settled bill")
    : bad(`a part payment recorded as ${p?.status ?? part.err}`);
  part.ok && Number(part.steps[6]?.[0]?.amount_expected) === 70000
    ? ok("and the remaining balance can still be paid — for exactly what is left")
    : bad(`the balance was uncollectable after a part payment: ${part.err ?? JSON.stringify(part.steps?.[6])}`);

  // ── F. Payment history ──────────────────────────────────────────────────
  const hist = await tryAs(me.id, `select count(*)::int n from my_payment_history()`);
  hist.ok
    ? ok(`sees ${hist.rows[0].n} payment(s) of their own, with the reference to quote`)
    : bad(`cannot read their payment history: ${hist.err}`);

  if (victim) {
    const leak = await tryAs(me.id,
      `select count(*)::int n from my_payment_history()
        where intent_id in (select id from payment_intents where payer_user_id = '${victim.id}')`);
    leak.ok && leak.rows[0].n === 0
      ? ok("and nobody else's")
      : bad(`SAW ${leak.rows?.[0]?.n} OF ANOTHER TENANT'S PAYMENTS`);
  }

  // ── G. Appraise the vendor ──────────────────────────────────────────────
  const { data: doneTicket } = await svc.from("tickets")
    .select("id, assigned_vendor_id").eq("org_id", o.id).eq("sender_id", me.id)
    .not("assigned_vendor_id", "is", null).in("status", ["resolved", "closed"])
    .limit(1).maybeSingle();
  if (!doneTicket) {
    note("no completed job of theirs with a vendor on it — appraisal not testable");
  } else {
    const rate = await tryAs(me.id,
      `select count(*)::int n from evaluation_criteria
        where active and measure = 'manual' and dimension = 'satisfaction'`);
    rate.ok && rate.rows[0].n > 0
      ? ok("is offered the satisfaction rubric — their dimension, not quality or compliance")
      : bad(`no satisfaction criteria available to the reporter: ${rate.err ?? "0 rows"}`);
  }

  // ── I. What stays shut ──────────────────────────────────────────────────
  const ledger = await tryAs(me.id, `select count(*)::int n from ledger_entries`);
  ledger.ok && ledger.rows[0].n === 0
    ? ok("reads no client-funds ledger — B7 holds")
    : bad(`A TENANT SAW ${ledger.rows?.[0]?.n} LEDGER ENTRIES`);

  const others = await tryAs(me.id,
    `select count(*)::int n from service_charges where billed_to_user_id is distinct from '${me.id}'`);
  others.ok && others.rows[0].n === 0
    ? ok("and no invoice that is not theirs")
    : bad(`A TENANT SAW ${others.rows?.[0]?.n} OTHER PEOPLE'S INVOICES`);

  console.log("");
}

// ── H. A notification cannot cross an organisation ────────────────────────
//
// Found while wiring section A: raising a request has to TELL someone, and
// `notify_role` took the target org as an argument and never checked it.
console.log("── notification boundary (all orgs) ──");
{
  const pairs = [];
  for (const a of tenantOrgs) for (const b of tenantOrgs) if (a.id !== b.id) pairs.push([a, b]);
  if (pairs.length === 0) note("only one organisation — cross-org notification not testable");

  let tested = 0;
  for (const [from, to] of pairs) {
    const { data: caller } = await svc.from("users").select("id")
      .eq("org_id", from.id).eq("role", "tenant").is("deactivated_at", null).limit(1).maybeSingle();
    const { data: target } = await svc.from("users").select("id")
      .eq("org_id", to.id).is("deactivated_at", null).limit(1).maybeSingle();
    if (!caller || !target) continue;
    tested++;

    const byRole = await tryAs(caller.id,
      `select notify_role('${to.id}', '{admin}'::user_role[], 'payment',
                          'Urgent: verify your bank details', 'tap to confirm', '/dashboard/settings') as n`);
    byRole.ok && byRole.rows[0].n === 0
      ? ok(`${from.slug} → ${to.slug}: notify_role writes nothing`)
      : bad(`!!! ${from.slug} WROTE ${byRole.rows?.[0]?.n} NOTIFICATION(S) INTO ${to.slug}`);

    const byUser = await tryAs(caller.id,
      `select notify_user('${target.id}', 'payment', 'Cross-org message', 'body', '/dashboard') as id`);
    byUser.ok && byUser.rows[0].id === null
      ? ok(`${from.slug} → ${to.slug}: notify_user writes nothing`)
      : bad(`!!! ${from.slug} NOTIFIED A NAMED USER IN ${to.slug}`);
  }

  // The jobs that legitimately write across orgs must still work. A boundary
  // that also breaks the rent-demand and lease-notice jobs is not a fix.
  if (tested > 0) {
    const target = tenantOrgs[0];
    const { data: anyone } = await svc.from("users").select("id")
      .eq("org_id", target.id).is("deactivated_at", null).limit(1).maybeSingle();
    await db.query("begin");
    const r = await db.query(
      `select notify_user('${anyone.id}', 'system', 'Scheduled job', 'body', '/dashboard') as id`
    );
    await db.query("rollback");
    r.rows[0].id
      ? ok("and a service-role caller (the scheduled jobs) still notifies anyone")
      : bad("the scheduled jobs can no longer notify — the boundary caught the wrong caller");
  }
}

await db.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a tenant can report, be answered, pay, and see what they paid; and cannot touch anyone else's."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
