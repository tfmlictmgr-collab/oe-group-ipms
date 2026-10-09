// The segregation headline tells the truth when a fund is overdrawn (0317).
//
// Reproduces production's own case inside ONE transaction that is rolled back:
// a property's service-charge fund pays out more than it holds under a fund
// override authorised by a real Payment Officer, in their own session. Then:
//
//   • the override records the real shortfall it covered (it used to say 0);
//   • `funds_owed` does not fall because a fund went negative;
//   • the overdrawn amount is stated on its own (`funds_overdrawn`);
//   • `unallocated` falls by exactly the overdrawn amount — the shortfall the
//     old formula hid by netting the negative fund against other debts.
//
// Usage: node scripts/verify-client-funds-position.mjs [--world staging]
import fs from "node:fs";
import pg from "pg";

const wi = process.argv.indexOf("--world");
const world = wi > 0 ? process.argv[wi + 1] : "staging";
if (world === "demo") { console.error("never the demo world"); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync(`.env.${world}.local`, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const db = new pg.Client({ host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT, database: env.SUPABASE_DB_NAME, user: env.SUPABASE_DB_USER, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await db.connect();

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));
const q = async (s, p) => (await db.query(s, p)).rows;
const num = (v) => Number(v ?? 0);

async function as(uid, fn) {
  await db.query("savepoint a");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  try { return await fn(); }
  catch (e) { await db.query("rollback to savepoint a"); throw e; }
  finally { await db.query("reset role"); await db.query("select set_config('request.jwt.claims', '', true)"); }
}

await db.query("begin");
try {
  const org = (await q("select id from orgs where slug = 'oea' and deleted_at is null"))[0];
  const officer = (await q(`select id from users where org_id = $1 and role = 'finance_approver' and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [org.id]))[0];
  const approver = (await q(`select id from users where org_id = $1 and role = 'payment_approver' and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [org.id]))[0];
  const tenant = (await q(`select id from users where org_id = $1 and role = 'tenant' and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [org.id]))[0];
  const bank = (await q(`select id from ledger_accounts where org_id = $1 and purpose = 'client_funds' and currency = 'NGN' and property_id is null order by code limit 1`, [org.id]))[0];
  // A property whose fund is not overdrawn, opened if it has none yet.
  const prop = (await q(`select p.id, p.name from properties p
      left join ledger_account_balances b on b.property_id = p.id and b.purpose = 'service_charge_fund' and b.currency = 'NGN'
     where p.org_id = $1 and p.deleted_at is null and coalesce(b.natural_balance, 0) >= 0
     order by p.created_at limit 1`, [org.id]))[0];
  if (!org || !officer || !approver || !tenant || !bank || !prop) {
    console.log("SKIP: needs OEA with a Payment Officer, a Payment Approver, a tenant, a client-funds account and a property");
    await db.query("rollback"); process.exit(0);
  }
  const fund = (await q(`select ensure_property_ledger_account($1, 'service_charge_fund'::ledger_account_purpose, $2, 'NGN') id`, [org.id, prop.id]))[0].id;
  const bal = async (id) => num((await q("select natural_balance from ledger_account_balances where account_id = $1", [id]))[0]?.natural_balance);
  const pos = async () => (await q("select funds_held, funds_owed, unallocated, funds_overdrawn, overdrawn_accounts from client_funds_position where org_id = $1 and currency = 'NGN'", [org.id]))[0];

  const held = await bal(fund);
  const bankHeld = await bal(bank.id);
  console.log(`Client-funds position (0317) on ${world} — fund of ${prop.name} holds ₦${held.toFixed(2)}\n`);
  if (held < 0) { console.log("SKIP: the chosen fund is already overdrawn; the arithmetic below assumes it is not"); await db.query("rollback"); process.exit(0); }
  const over = 1000;
  const spend = held + over;
  if (bankHeld < spend) { console.log("SKIP: the client-funds account cannot cover the fixture spend"); await db.query("rollback"); process.exit(0); }

  const before = await pos();

  console.log("A. The override is authorised in the Payment Officer's own session");
  const overrideId = await as(officer.id, async () =>
    (await q("select authorise_fund_override($1, 'Walkthrough suite: fund short, topped up from operating account') id", [fund]))[0].id);
  const ov1 = (await q("select * from fund_overrides where id = $1", [overrideId]))[0];
  check(num(ov1.fund_balance_at_authorisation) === held, `it records what the fund held when authorised (₦${num(ov1.fund_balance_at_authorisation).toFixed(2)})`);
  check(num(ov1.shortfall_at_authorisation) === 0, "and that it was not already overdrawn (0)");

  console.log("\nB. A payment overruns the fund by ₦1,000 and posts");
  const entry = (await q(`insert into ledger_entries (org_id, entry_date, description, source) values ($1, current_date, 'Verify suite: overdraw a fund', 'adjustment') returning id`, [org.id]))[0].id;
  await q(`insert into ledger_postings (org_id, entry_id, account_id, amount) values ($1, $2, $3, $4), ($1, $2, $5, $6)`, [org.id, entry, fund, spend, bank.id, -spend]);
  await db.query("set constraints all immediate");
  const ov2 = (await q("select * from fund_overrides where id = $1", [overrideId]))[0];
  check(ov2.consumed_entry_id === entry, "the override is consumed by that posting");
  check(num(ov2.shortfall_covered) === over, `it records the shortfall it covered: ₦${num(ov2.shortfall_covered).toFixed(2)} (was always 0)`);

  console.log("\nC. The headline says what happened");
  const after = await pos();
  check(num(after.funds_held) === num(before.funds_held) - spend, "held fell by the whole payment");
  check(num(after.funds_owed) === num(before.funds_owed) - held, `owed fell only by what the fund actually held (₦${held.toFixed(2)}), not by the overrun`);
  check(num(after.funds_overdrawn) === num(before.funds_overdrawn) + over, `the overdrawn amount is stated on its own (+₦${over})`);
  check(num(after.overdrawn_accounts) === num(before.overdrawn_accounts) + 1, "one more account is counted as overdrawn");
  check(Math.abs(num(after.unallocated) - (num(before.unallocated) - over)) < 0.005,
    `unallocated fell by exactly the overrun (₦${num(before.unallocated).toFixed(2)} → ₦${num(after.unallocated).toFixed(2)})`);
  // The pre-0317 formula netted every overdrawn account against the debts:
  // held - (owed - overdrawn). Computed before and after the same payment, it
  // does not move at all — which is exactly the shortfall it used to hide.
  const oldOf = (p) => num(p.funds_held) - (num(p.funds_owed) - num(p.funds_overdrawn));
  check(Math.abs(oldOf(after) - oldOf(before)) < 0.005, "the old formula would have reported no change at all — the defect being fixed");

  console.log("\nD. Who can read the position");
  const apRows = await as(approver.id, async () => (await q("select count(*)::int n from client_funds_position where org_id = $1", [org.id]))[0].n);
  check(apRows > 0, "the Payment Approver (head of accounts) reads it");
  const tRows = await as(tenant.id, async () => {
    const r = await q("select funds_held, funds_owed from client_funds_position where org_id = $1", [org.id]);
    return r.filter((x) => x.funds_held !== null || x.funds_owed !== null).length;
  });
  check(tRows === 0, "a tenant reads no figures from it");
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : "\nALL CHECKS PASSED — an overdrawn fund shows as a shortfall, and the override records what it covered");
process.exit(failures ? 1 : 0);
