// Verifies 0315: a service-charge budget filed in error is voided or deleted,
// never moved.
//
// Every act runs in a signed-in user's own session (`set local role
// authenticated` with their claims), inside ONE transaction that is rolled
// back at the end — nothing this suite writes survives it.
//
// Usage: node scripts/verify-sc-budget-void.mjs [--env .env.dev.local]
import path from "node:path";
import crypto from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile), quiet: true, override: true });
requireNonProductionTarget(process.cwd(), "Writes budget fixtures in a rolled-back transaction.");

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
/** Runs `sql`; returns the refusal message, or null if it succeeded. */
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

console.log(`\nService-charge budget void / delete (0315) · ${envFile}`);
await db.connect();
await db.query("begin");

try {
  const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
  const byRole = (role) => one(
    `select id from users where org_id = $1 and role = $2 and deactivated_at is null
       and email like 'oea.%@oegroup.test' order by email limit 1`,
    [org.id, role]
  );
  const approver = await byRole("payment_approver");
  const pm = await byRole("property_manager");
  const fm = await byRole("facility_manager");
  if (!approver || !pm || !fm) throw new Error("demo accounts missing (payment_approver, property_manager, facility_manager)");

  const prop = await one(
    `select p.id from properties p
      where p.org_id = $1 and p.deleted_at is null
        and exists (select 1 from units u where u.property_id = p.id and u.deleted_at is null)
      order by p.created_at limit 1`,
    [org.id]
  );
  const other = await one(
    "select id from properties where org_id = $1 and deleted_at is null and id <> $2 order by created_at limit 1",
    [org.id, prop.id]
  );
  const unit = await one("select id from units where property_id = $1 and deleted_at is null limit 1", [prop.id]);
  const period = `VOIDPROBE-${crypto.randomBytes(3).toString("hex")}`;

  // ── Fixture: an invoiced budget, raised as the payment approver ──────────
  await as(approver.id);
  const budget = await one(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status)
     values ($1, $2, $3, 100, 'draft') returning id`,
    [org.id, prop.id, period]
  );
  const inv = await one(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, $4, 100, 'invoiced', 'probe') returning id`,
    [org.id, budget.id, unit.id, period]
  );
  await db.query("update sc_budgets set status = 'invoiced' where id = $1", [budget.id]);

  section("A. A budget's property is fixed");
  let m = await refused("update sc_budgets set property_id = $2 where id = $1", [budget.id, other.id]);
  check(/cannot be moved to another property/.test(m ?? ""), "moving an invoiced budget to another property is refused", m);

  section("B. Void only through Void budget");
  m = await refused("update sc_budgets set status = 'void' where id = $1", [budget.id]);
  check(/voided with Void budget/.test(m ?? ""), "a direct PATCH to status = 'void' is refused", m);
  m = await refused("update sc_budgets set void_reason = 'sneaking a reason in' where id = $1", [budget.id]);
  check(/Only a voided budget carries void details/.test(m ?? ""), "void details cannot be set on a live budget", m);

  section("C. Who may void, and with what");
  await as(fm.id);
  m = await refused("select void_sc_budget($1, 'filed on the wrong property')", [budget.id]);
  check(/permission/.test(m ?? ""), "a facilities manager (no sc.manage) is refused", m);
  await as(approver.id);
  m = await refused("select void_sc_budget($1, 'oops')", [budget.id]);
  check(/at least 10 characters/.test(m ?? ""), "a reason under 10 characters is refused", m);

  section("D. Refused while money is attached");
  await asOwner();
  const intent = await one(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, status, gateway, gateway_reference, service_charge_id)
     values ($1, 'service_charge', 100, 'NGN', 'pending', 'simulated', $2, $3) returning id`,
    [org.id, `VOIDPROBE-${crypto.randomBytes(4).toString("hex")}`, inv.id]
  );
  await as(approver.id);
  m = await refused("select void_sc_budget($1, 'filed on the wrong property')", [budget.id]);
  check(/cannot be voided/.test(m ?? ""), "an open payment request blocks the void", m);
  await asOwner();
  await db.query("update payment_intents set status = 'abandoned' where id = $1", [intent.id]);

  section("E. Void");
  await as(approver.id);
  m = await refused("select void_sc_budget($1, 'filed on the wrong property in testing')", [budget.id]);
  check(m === null, "an abandoned request no longer blocks; the void succeeds", m);
  await asOwner();
  const after = await one("select status, voided_by, void_reason, voided_at from sc_budgets where id = $1", [budget.id]);
  check(after.status === "void" && after.voided_by === approver.id && after.voided_at,
    "the budget is void, attributed to the approver, and dated");
  const live = await one("select count(*)::int n from service_charges where budget_id = $1 and deleted_at is null", [budget.id]);
  check(live.n === 0, "every invoice on it is retired");
  const aud = await one(
    `select count(*)::int n from audit_log where entity_id = $1 and action = 'sc_budget.status_change'
       and after_state->>'status' = 'void' and actor_id = $2`,
    [budget.id, approver.id]
  );
  check(aud.n === 1, "the void is in the audit trail, with its actor");

  section("F. A void budget is closed");
  await as(approver.id);
  m = await refused("update sc_budgets set total_amount = 200 where id = $1", [budget.id]);
  check(/voided, so it can no longer be changed/.test(m ?? ""), "it cannot be edited", m);
  m = await refused(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, $4, 100, 'invoiced', 'probe')`,
    [org.id, budget.id, unit.id, period]
  );
  check(/nothing can be invoiced against it/.test(m ?? ""), "nothing new can be invoiced against it", m);
  await asOwner();
  m = await refused("update service_charges set deleted_at = null where id = $1", [inv.id]);
  check(/nothing can be invoiced against it/.test(m ?? ""), "a retired invoice cannot be brought back (even server-side)", m);
  await as(approver.id);
  m = await refused("delete from sc_budgets where id = $1", [budget.id]);
  check(m !== null || refused.last.rowCount === 0, "a voided budget cannot be deleted (its invoices are records)", m);

  section("G. The slot is free for the correct budget");
  m = await refused(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status) values ($1, $2, $3, 100, 'draft')`,
    [org.id, prop.id, period]
  );
  check(m === null, "a new budget for the same property and period can be raised", m);

  section("H. Delete a draft nothing references");
  // The property manager when they hold a property in this world (the place-
  // scoped path); otherwise the approver, whose reach is the organisation.
  await as(pm.id);
  const pmProp = await one(
    `select id from properties where id in (select current_user_property_ids()) and org_id = $1 limit 1`,
    [org.id]
  );
  const deleter = pmProp ? { who: "property manager", id: pm.id, prop: pmProp.id }
                         : { who: "payment approver", id: approver.id, prop: prop.id };
  await as(deleter.id);
  const draft = await one(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status)
     values ($1, $2, $3, 50, 'draft') returning id`,
    [org.id, deleter.prop, `${period}-D`]
  );
  m = await refused("delete from sc_budgets where id = $1", [draft.id]);
  check(m === null && refused.last.rowCount === 1, `the ${deleter.who} deletes a draft nothing references`, m);
  await asOwner();
  const del = await one(
    "select count(*)::int n from audit_log where entity_id = $1 and action = 'sc_budget.deleted' and actor_id = $2",
    [draft.id, deleter.id]
  );
  check(del.n === 1, "the deletion is in the audit trail, with its actor");

  section("I. The dashboard stops counting it");
  await asOwner();
  const bi = await one("select count(*)::int n from bi_budget_utilisation where budget_id = $1", [budget.id]);
  check(bi.n === 0, "bi_budget_utilisation leaves the void budget out");
} catch (e) {
  bad(`unexpected error: ${e.message}`);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mALL CHECKS PASSED — a budget filed in error is voided or deleted, attributed, and never moved.\x1b[0m");
