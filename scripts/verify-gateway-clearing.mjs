// Online money waits at the gateway until it settles (0319/0320).
//
// Inside ONE rolled-back transaction, with the bookkeeping steps taken in a
// real Payment Officer's session:
//   A. an online collection lands in the gateway balance, a bank transfer in the bank;
//   B. a settlement moves it to the bank net of fees, fees to Bank charges;
//   C. a settlement is refused for more than is waiting, twice, in the future, or by the wrong desk;
//   D. a Paystack payout is paid from the Paystack balance; a top-up moves bank → Paystack;
//   E. a bank charge, and funding an overdrawn fund from the organisation's own money;
//   F. money at the gateway still counts as client money held.
//
// Usage: node scripts/verify-gateway-clearing.mjs [--world staging]
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
const near = (a, b) => Math.abs(a - b) < 0.005;

async function as(uid, fn) {
  await db.query("savepoint a");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  try { return await fn(); }
  catch (e) { await db.query("rollback to savepoint a"); throw e; }
  finally { await db.query("reset role"); await db.query("select set_config('request.jwt.claims', '', true)"); }
}
async function refused(uid, sql, params, re, label) {
  try { await as(uid, () => q(sql, params)); bad(`${label} — NOT refused`); }
  catch (e) { check(re.test(e.message), `${label} (${e.message.slice(0, 90)})`); }
}

await db.query("begin");
try {
  const org = (await q("select id from orgs where slug = 'oea' and deleted_at is null"))[0];
  const pick = async (role) => (await q(`select id from users where org_id = $1 and role = $2 and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [org.id, role]))[0];
  const officer = await pick("finance_approver");
  const admin = await pick("admin");
  const tenant = await pick("tenant");
  const bank = (await q(`select * from bank_accounts where org_id = $1 and purpose = 'client_funds' and currency = 'NGN' and active and ledger_account_id is not null order by created_at limit 1`, [org.id]))[0];
  if (!officer || !admin || !tenant || !bank) { console.log("SKIP: needs OEA with a Payment Officer, an admin, a tenant and an NGN client-funds bank account"); await db.query("rollback"); process.exit(0); }
  const bal = async (id) => num((await q("select natural_balance from ledger_account_balances where account_id = $1", [id]))[0]?.natural_balance);
  const paystack = (await q("select ensure_gateway_clearing_account($1, 'paystack', 'NGN') id", [org.id]))[0].id;
  const charges = (await q("select canonical_ledger_account($1, 'bank_charges'::ledger_account_purpose, 'NGN') id", [org.id]))[0].id;

  console.log(`Gateway clearing (0319/0320) on ${world}\n`);

  console.log("A. Where a collection lands");
  const bank0 = await bal(bank.ledger_account_id), ps0 = await bal(paystack);
  const intent = async (gateway, amount) => (await q(
    `insert into payment_intents (org_id, purpose, amount_expected, currency, gateway, status, gateway_reference, created_by)
     values ($1, 'other', $2, 'NGN', $3::payment_gateway, 'pending', 'GWTEST-' || substr(md5(random()::text), 1, 10), $4) returning id`,
    [org.id, amount, gateway, admin.id]))[0].id;
  const online = await intent("paystack", 5000);
  await q("select record_collection($1, 5000, now())", [online]);
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(paystack), ps0 + 5000), "a Paystack payment lands in the Paystack balance");
  check(near(await bal(bank.ledger_account_id), bank0), "and NOT in the bank");
  const manual = await intent("manual", 700);
  await q("select record_collection($1, 700, now())", [manual]);
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(bank.ledger_account_id), bank0 + 700), "a confirmed bank transfer lands in the bank");

  console.log("\nB. Settlement, net of fees");
  const bank1 = await bal(bank.ledger_account_id), ps1 = await bal(paystack), ch1 = await bal(charges);
  const ref = "STL-" + Math.random().toString(36).slice(2, 8);
  await as(officer.id, () => q("select record_gateway_settlement($1, 'paystack', current_date, 5000, 75, $2)", [bank.id, ref]));
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(bank.ledger_account_id), bank1 + 4925), "the bank receives the net (₦4,925)");
  check(near(await bal(paystack), ps1 - 5000), "the Paystack balance gives up the gross (₦5,000)");
  check(near(await bal(charges), ch1 + 75), "the fee is recorded as a bank charge (₦75)");

  console.log("\nC. What a settlement refuses");
  await refused(officer.id, "select record_gateway_settlement($1, 'paystack', current_date, 10, 0, $2)", [bank.id, ref], /already recorded/, "the same settlement twice");
  const waiting = await bal(paystack);
  await refused(officer.id, "select record_gateway_settlement($1, 'paystack', current_date, $2, 0, 'STL-OVER-1')", [bank.id, Math.max(waiting, 0) + 1000], /waiting at Paystack/, "more than the ledger shows waiting");
  await refused(officer.id, "select record_gateway_settlement($1, 'paystack', current_date + 1, 10, 0, 'STL-FUT-1')", [bank.id], /future/, "a date in the future");
  await refused(admin.id, "select record_gateway_settlement($1, 'paystack', current_date, 10, 0, 'STL-ADM-1')", [bank.id], /Payment Officer or the Payment Approver/, "an administrator");
  await refused(tenant.id, "select record_gateway_settlement($1, 'paystack', current_date, 10, 0, 'STL-TEN-1')", [bank.id], /Payment Officer or the Payment Approver|permission denied/, "a tenant");

  console.log("\nD. Paystack payouts and top-ups");
  const bank2 = await bal(bank.ledger_account_id), ps2 = await bal(paystack);
  await as(officer.id, () => q("select record_gateway_topup($1, 'paystack', current_date, 1000, 'TOPUP-TEST-1')", [bank.id]));
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(paystack), ps2 + 1000) && near(await bal(bank.ledger_account_id), bank2 - 1000), "a top-up moves ₦1,000 from the bank to the Paystack balance");
  const recipient = (await q(`select id from payout_recipients where org_id = $1 order by created_at limit 1`, [org.id]))[0];
  const landlordPayable = (await q("select canonical_ledger_account($1, 'landlord_payable'::ledger_account_purpose, 'NGN') id", [org.id]))[0].id;
  if (recipient && (await bal(landlordPayable)) >= 300) {
    const rem = (await q(
      `insert into remittances (org_id, party, recipient_id, gross_amount, management_fee, admin_fee, net_amount, currency, status, reference, gateway, bank_account_id, created_by)
       values ($1, 'other', $2, 300, 0, 0, 300, 'NGN', 'sending', 'GWREM-' || substr(md5(random()::text), 1, 8), 'paystack', $3, $4) returning id`,
      [org.id, recipient.id, bank.id, officer.id]))[0].id;
    const bank3 = await bal(bank.ledger_account_id), ps3 = await bal(paystack);
    await q("select record_remittance_sent($1, 'TRF-TEST', now())", [rem]);
    await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
    check(near(await bal(paystack), ps3 - 300) && near(await bal(bank.ledger_account_id), bank3), "a Paystack payout is paid from the Paystack balance, not the bank");
  } else {
    console.log("  SKIP the payout check: no payout recipient, or the landlord payable is too small on this world");
  }

  console.log("\nE. Bank charges and an overdrawn fund");
  const bank4 = await bal(bank.ledger_account_id), ch4 = await bal(charges);
  await as(officer.id, () => q("select record_bank_charge($1, current_date, 50, 'Monthly account maintenance fee')", [bank.id]));
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(bank.ledger_account_id), bank4 - 50) && near(await bal(charges), ch4 + 50), "a bank charge leaves the bank and is recorded as a charge");
  await refused(officer.id, "select record_bank_charge($1, current_date, 50, 'fee')", [bank.id], /10 characters/, "a charge without a reason");

  const prop = (await q(`select p.id from properties p left join ledger_account_balances b on b.property_id = p.id and b.purpose = 'service_charge_fund' and b.currency = 'NGN'
                          where p.org_id = $1 and p.deleted_at is null and coalesce(b.natural_balance, 0) >= 0 order by p.created_at limit 1`, [org.id]))[0];
  const fund = (await q(`select ensure_property_ledger_account($1, 'service_charge_fund'::ledger_account_purpose, $2, 'NGN') id`, [org.id, prop.id]))[0].id;
  const held = await bal(fund);
  await as(officer.id, () => q("select authorise_fund_override($1, 'Verify suite: overdraw then fund from own money')", [fund]));
  const e = (await q(`insert into ledger_entries (org_id, entry_date, description, source) values ($1, current_date, 'Verify suite: overdraw a fund', 'adjustment') returning id`, [org.id]))[0].id;
  await q(`insert into ledger_postings (org_id, entry_id, account_id, amount) values ($1, $2, $3, $4), ($1, $2, $5, $6)`, [org.id, e, fund, held + 400, bank.ledger_account_id, -(held + 400)]);
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(fund), -400), "the fixture fund is overdrawn by ₦400");
  await refused(officer.id, "select fund_overdrawn_account($1, $2, current_date, 500, 'DEP-TEST-1', 'Topped up from the branch account')", [fund, bank.id], /overdrawn by only/, "funding more than the overdraft");
  const bank5 = await bal(bank.ledger_account_id);
  await as(officer.id, () => q("select fund_overdrawn_account($1, $2, current_date, 400, 'DEP-TEST-1', 'Topped up from the branch account')", [fund, bank.id]));
  await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
  check(near(await bal(fund), 0) && near(await bal(bank.ledger_account_id), bank5 + 400), "funding ₦400 from the organisation's own money restores the fund to zero");
  await refused(officer.id, "select fund_overdrawn_account($1, $2, current_date, 1, 'DEP-TEST-2', 'Topped up from the branch account')", [fund, bank.id], /not overdrawn/, "funding an account that is no longer overdrawn");

  console.log("\nF. Money at the gateway is client money held");
  const pos = (await q("select funds_held, funds_at_gateway from client_funds_position where org_id = $1 and currency = 'NGN'", [org.id]))[0];
  const bankAll = num((await q("select sum(natural_balance) s from ledger_account_balances where org_id = $1 and currency = 'NGN' and purpose = 'client_funds'", [org.id]))[0].s);
  const gwAll = num((await q("select sum(natural_balance) s from ledger_account_balances where org_id = $1 and currency = 'NGN' and purpose = 'gateway_clearing'", [org.id]))[0].s);
  check(near(num(pos.funds_at_gateway), gwAll), `funds_at_gateway states the gateway balances (₦${gwAll.toFixed(2)})`);
  check(near(num(pos.funds_held), bankAll + gwAll), "funds_held = bank + gateway");
  const tSee = await as(tenant.id, () => q("select count(*)::int n from ledger_accounts where purpose = 'gateway_clearing'"));
  check(tSee[0].n === 0, "a tenant cannot see the gateway account");
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : "\nALL CHECKS PASSED — online money waits at the gateway, settles net of fees, and every movement finance needs can be recorded");
process.exit(failures ? 1 : 0);
