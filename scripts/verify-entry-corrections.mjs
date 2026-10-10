// Verifies 0328 and 0329:
//   • an allocated unit can be let to its occupant, and only to them;
//   • a tenancy, a rent demand and a service-charge budget entered by mistake
//     are corrected through one audited path each, with a reason, and never
//     once money has touched them;
//   • the direct-write holes that let a live tenancy's rent or an invoiced
//     budget's total be rewritten silently are closed.
//
// Every act runs in a signed-in user's own session inside ONE transaction that
// is rolled back at the end.
//
// Usage: node scripts/verify-entry-corrections.mjs [--env .env.dev.local]
import path from "node:path";
import crypto from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const envArg = process.argv.indexOf("--env");
const envFile = envArg > -1 ? process.argv[envArg + 1] : ".env.local";
config({ path: path.join(process.cwd(), envFile), quiet: true, override: true });
requireNonProductionTarget(process.cwd(), "Writes tenancy and budget fixtures in a rolled-back transaction.");

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
  const email = `probe-corrections-${label}-${id.slice(0, 8)}@oegroup.test`;
  await db.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
  await db.query("insert into users (id, org_id, role, full_name, email) values ($1, $2, $3, $4, $5)",
    [id, orgId, role, `Probe ${label}`, email]);
  return id;
}

console.log(`\nEntry corrections and lettable units (0328/0329) · ${envFile}`);
await db.connect();
await db.query("begin");

try {
  const org = await one("select id from orgs where slug = 'oea' and deleted_at is null");
  const byRole = (role) => one(
    `select id from users where org_id = $1 and role = $2 and deactivated_at is null
       and email like 'oea.%@oegroup.test' order by email limit 1`, [org.id, role]);
  const pm = await byRole("property_manager");
  const fm = await byRole("facility_manager");
  const approver = await byRole("payment_approver");
  if (!pm || !fm || !approver) throw new Error("demo accounts missing");

  // A fresh property of our own, with two units, staked to the PM and the FM.
  await asOwner();
  const prop = await one(
    "insert into properties (org_id, name, address) values ($1, $2, 'Probe Close') returning id",
    [org.id, `PROBE-CORR-${crypto.randomBytes(3).toString("hex")}`]
  );
  const u1 = await one("insert into units (org_id, property_id, label, apportionment_factor) values ($1, $2, 'Flat 1', 100) returning id", [org.id, prop.id]);
  const u2 = await one("insert into units (org_id, property_id, label, apportionment_factor) values ($1, $2, 'Flat 2', 100) returning id", [org.id, prop.id]);
  for (const uid of [pm.id, fm.id]) {
    await db.query("insert into property_stakeholders (org_id, property_id, user_id, relation) values ($1, $2, $3, 'manager')",
      [org.id, prop.id, uid]);
  }
  const occupant = await newUser(org.id, "tenant", "occupant");
  const stranger = await newUser(org.id, "tenant", "stranger");
  await db.query("update units set occupant_user_id = $1 where id = $2", [occupant, u1.id]);

  section("A. An allocated unit is offered to the lease form");
  await as(pm.id);
  const vacant = (await db.query("select id from vacant_units_for_property($1)", [prop.id])).rows.map((r) => r.id);
  const lettable = (await db.query("select id, occupant_user_id from lettable_units_for_property($1)", [prop.id])).rows;
  check(!vacant.includes(u1.id), "the allocated unit is still not vacant (vacancy is unchanged)");
  const offered = lettable.find((r) => r.id === u1.id);
  check(Boolean(offered), "but it is offered for a tenancy");
  check(offered?.occupant_user_id === occupant, "with its occupant named, so the tenancy is theirs");
  check(lettable.some((r) => r.id === u2.id), "the empty unit is offered as before");

  section("B. A tenancy on an allocated unit is for its occupant");
  let m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, $4, current_date, current_date + 365, 1000000, 'annual') returning id`,
    [org.id, prop.id, u1.id, stranger]
  );
  check(/allocated to someone else/.test(m ?? ""), "a tenancy for a different tenant is refused", m);
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_user_id, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, $4, current_date, current_date + 365, 1000000, 'annual') returning id`,
    [org.id, prop.id, u1.id, occupant]
  );
  check(m === null, "a tenancy for the occupant is recorded", m);
  const lease = refused.last.rows[0];

  section("C. Tenancy terms: a draft edits freely, a live one needs a reason");
  m = await refused("select correct_lease_terms($1, 1100000, 'annual', 0, 0, current_date, current_date + 365, null)", [lease.id]);
  check(m === null, "a draft's rent is corrected without a reason", m);
  m = await refused("select activate_lease($1)", [lease.id]);
  check(m === null, "the tenancy is activated", m);
  m = await refused("update leases set rent_amount = 1 where id = $1 returning id", [lease.id]);
  check(/corrected with Correct tenancy details/.test(m ?? ""), "a direct write to a live tenancy's rent is refused", m);
  m = await refused("update leases set unit_id = $2 where id = $1", [lease.id, u2.id]);
  check(/cannot be moved to another unit/.test(m ?? ""), "a live tenancy cannot be moved to another unit", m);
  m = await refused("select correct_lease_terms($1, 1200000, 'annual', 0, 0, current_date, current_date + 365, 'typo')", [lease.id]);
  check(/at least 10 characters/.test(m ?? ""), "a live correction without a proper reason is refused", m);
  await as(fm.id);
  m = await refused("select correct_lease_terms($1, 1200000, 'annual', 0, 0, current_date, current_date + 365, 'rent keyed wrongly at entry')", [lease.id]);
  check(/do not have permission/.test(m ?? ""), "a facilities manager (no leases.write) is refused", m);
  await as(pm.id);
  m = await refused("select correct_lease_terms($1, 1200000, 'annual', 50000, 0, current_date, current_date + 365, 'rent keyed wrongly at entry')", [lease.id]);
  check(m === null, "the property manager corrects it with a reason", m);
  await asOwner();
  const after = await one("select rent_amount, deposit_amount from leases where id = $1", [lease.id]);
  check(Number(after.rent_amount) === 1200000 && Number(after.deposit_amount) === 50000, "the new terms are recorded",
    `${after.rent_amount} / ${after.deposit_amount}`);
  const audited = await one(
    "select actor_id, after_state->>'reason' reason from audit_log where action = 'lease.terms_corrected' and entity_id = $1 and after_state->>'reason' is not null",
    [lease.id]
  );
  check(audited?.actor_id === pm.id && audited?.reason === "rent keyed wrongly at entry",
    "the audit trail names who corrected it and why", JSON.stringify(audited));

  section("D. A rent demand, while nothing has happened to it");
  await as(pm.id);
  const charge = await one("select raise_rent_charge($1, '2399-01-01', '2399-12-31', '2399-01-01') id", [lease.id]);
  await asOwner();
  const before = await one("select management_fee_pct, admin_fee_amount from rent_charges where id = $1", [charge.id]);
  await as(pm.id);
  m = await refused("select correct_rent_charge($1, 1000000, '2399-01-01', '2399-12-31', null, 'demand raised at the wrong amount')", [charge.id]);
  check(m === null, "an untouched demand is corrected with a reason", m);
  await asOwner();
  const rc = await one("select amount, management_fee_amount, landlord_net_amount, management_fee_pct from rent_charges where id = $1", [charge.id]);
  const fee = Math.round(1000000 * Number(before.management_fee_pct)) / 100;
  check(Number(rc.amount) === 1000000, "the amount is corrected");
  check(Number(rc.management_fee_amount) === fee && Number(rc.management_fee_pct) === Number(before.management_fee_pct),
    "the fee is recomputed at the rate frozen on the demand", `${rc.management_fee_amount} at ${rc.management_fee_pct}%`);
  check(Number(rc.landlord_net_amount) === 1000000 - fee - Number(before.admin_fee_amount), "and the landlord's share follows");
  await db.query(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, status, gateway, gateway_reference, rent_charge_id)
     values ($1, 'rent', 1000000, 'NGN', 'pending', 'simulated', $2, $3)`,
    [org.id, `CORRPROBE-${crypto.randomBytes(4).toString("hex")}`, charge.id]
  );
  await as(pm.id);
  m = await refused("select correct_rent_charge($1, 900000, '2399-01-01', '2399-12-31', null, 'demand raised at the wrong amount')", [charge.id]);
  check(/payment request is open or paid/.test(m ?? ""), "an open payment request blocks the correction", m);
  m = await refused("update rent_charges set amount = 1 where id = $1 returning id", [charge.id]);
  check(m !== null || refused.last.rowCount === 0, "a direct write to a demand changes nothing", m);

  section("E. A service-charge budget: fix the inputs, re-issue");
  await as(approver.id);
  const budget = await one(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status)
     values ($1, $2, $3, 200000, 'draft') returning id`,
    [org.id, prop.id, `CORRPROBE-${crypto.randomBytes(3).toString("hex")}`]
  );
  const inv = await one(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, 'probe', 200000, 'invoiced', 'probe') returning id`,
    [org.id, budget.id, u2.id]
  );
  await db.query("update sc_budgets set status = 'invoiced' where id = $1", [budget.id]);
  m = await refused("update sc_budgets set total_amount = 250000 where id = $1", [budget.id]);
  check(/corrected with Correct and re-issue/.test(m ?? ""), "a direct change to an invoiced budget's total is refused", m);
  m = await refused("update sc_budgets set status = 'draft' where id = $1", [budget.id]);
  check(/corrected with Correct and re-issue/.test(m ?? ""), "an invoiced budget cannot be put back to draft directly", m);
  await asOwner();
  const intent = await one(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, status, gateway, gateway_reference, service_charge_id)
     values ($1, 'service_charge', 200000, 'NGN', 'pending', 'simulated', $2, $3) returning id`,
    [org.id, `CORRPROBE-${crypto.randomBytes(4).toString("hex")}`, inv.id]
  );
  await as(pm.id);
  m = await refused("select reopen_sc_budget_for_correction($1, 250000, null, 'budget total keyed wrongly')", [budget.id]);
  check(/cannot be re-issued/.test(m ?? ""), "an open payment request blocks the re-issue", m);
  await asOwner();
  await db.query("update payment_intents set status = 'abandoned' where id = $1", [intent.id]);
  await as(fm.id);
  m = await refused("select reopen_sc_budget_for_correction($1, 250000, null, 'budget total keyed wrongly')", [budget.id]);
  check(/do not have permission/.test(m ?? ""), "a facilities manager (no sc.manage) is refused", m);
  await as(pm.id);
  m = await refused("select reopen_sc_budget_for_correction($1, 250000, null, 'short')", [budget.id]);
  check(/at least 10 characters/.test(m ?? ""), "a reason under 10 characters is refused", m);
  m = await refused("select reopen_sc_budget_for_correction($1, 250000, null, 'budget total keyed wrongly') n", [budget.id]);
  check(m === null && Number(refused.last.rows[0].n) === 1, "the property manager re-issues it; one invoice withdrawn", m);
  await asOwner();
  const b = await one("select status, total_amount from sc_budgets where id = $1", [budget.id]);
  check(b.status === "draft" && Number(b.total_amount) === 250000, "the budget is back to draft at the corrected total", JSON.stringify(b));
  const gone = await one("select deleted_at from service_charges where id = $1", [inv.id]);
  check(gone.deleted_at !== null, "its old invoice is withdrawn, not deleted");
  const trail = await one(
    "select after_state->>'reason' reason from audit_log where action = 'sc_budget.reopened_for_correction' and entity_id = $1",
    [budget.id]
  );
  check(trail?.reason === "budget total keyed wrongly", "the audit trail records why");

  section("F. A record with a tenant or money on it is not hidden (0332)");
  await as(pm.id);
  m = await refused("update leases set deleted_at = now() where id = $1", [lease.id]);
  check(/cannot be deleted/.test(m ?? ""), "a live tenancy cannot be soft-deleted by a direct write", m);
  m = await refused(
    `insert into leases (org_id, property_id, unit_id, tenant_name, start_date, end_date, rent_amount, rent_frequency)
     values ($1, $2, $3, 'PROBE draft', current_date + 400, current_date + 765, 500000, 'annual') returning id`,
    [org.id, prop.id, u2.id]
  );
  const draft = refused.last?.rows?.[0];
  check(m === null && Boolean(draft), "a draft tenancy is recorded", m);
  if (draft) {
    m = await refused("update leases set deleted_at = now() where id = $1", [draft.id]);
    check(m === null, "a draft that was never live can be removed", m);
    m = await refused("update leases set deleted_at = null where id = $1", [draft.id]);
    check(m === null, "and put back", m);
  }
  await asOwner();
  await db.query("update leases set deleted_at = now() where id = $1", [lease.id]);
  await as(pm.id);
  m = await refused("update leases set deleted_at = null where id = $1", [lease.id]);
  check(/cannot be restored/.test(m ?? ""), "a deleted live tenancy cannot be revived by a direct write", m);
  await asOwner();
  await db.query("update leases set deleted_at = null where id = $1", [lease.id]);

  await as(approver.id);
  const b2 = await one(
    `insert into sc_budgets (org_id, property_id, period, total_amount, status)
     values ($1, $2, $3, 300000, 'draft') returning id`,
    [org.id, prop.id, `CORRPROBE-${crypto.randomBytes(3).toString("hex")}`]
  );
  const paidInv = await one(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, 'probe', 150000, 'invoiced', 'probe') returning id`,
    [org.id, b2.id, u1.id]
  );
  const unpaidInv = await one(
    `insert into service_charges (org_id, budget_id, unit_id, billing_period, amount, status, property_or_unit)
     values ($1, $2, $3, 'probe', 150000, 'invoiced', 'probe') returning id`,
    [org.id, b2.id, u2.id]
  );
  await asOwner();
  await db.query("update service_charges set amount_paid = 50000, status = 'part_paid' where id = $1", [paidInv.id]);
  await as(pm.id);
  m = await refused("update service_charges set deleted_at = now() where id = $1", [paidInv.id]);
  check(/money attached/.test(m ?? ""), "a part-paid invoice cannot be withdrawn by a direct write", m);
  m = await refused("update service_charges set deleted_at = now() where id = $1", [unpaidInv.id]);
  check(/withdrawn with Regenerate/.test(m ?? ""), "an unpaid invoice is withdrawn only through the budget's own controls", m);
  // Either refusal will do: RLS hides a withdrawn invoice from the manager, so
  // the write usually matches nothing before the guard is even asked.
  m = await refused("update service_charges set deleted_at = null where id = $1 returning id", [inv.id]);
  check(/cannot be revived/.test(m ?? "") || (m === null && refused.last.rowCount === 0),
    "a withdrawn invoice cannot be revived by a direct write", m);
  m = await refused("select retire_service_charges_for_regenerate($1)", [b2.id]);
  check(/money attached/.test(m ?? ""), "Regenerate refuses a budget whose invoice has money on it", m);
  await asOwner();
  await db.query("update service_charges set amount_paid = 0, status = 'invoiced' where id = $1", [paidInv.id]);
  await as(pm.id);
  m = await refused("select retire_service_charges_for_regenerate($1)", [b2.id]);
  check(m === null, "and still withdraws an untouched budget's invoices", m);
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
console.log("\n\x1b[32mALL CHECKS PASSED — mistaken entries are corrected with a reason, never after money moves, and an allocated unit can be let to its occupant.\x1b[0m");
