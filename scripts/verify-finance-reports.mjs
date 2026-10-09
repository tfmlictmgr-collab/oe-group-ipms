// The head of accounts' reports (0318) agree with the ledger, and with each
// reader's own access.
//
// Every report function is SECURITY INVOKER, so the same call answers
// differently per seat: the Payment Approver (oversight) reads the organisation,
// a tenant reads their own payments and none of the ledger. Each check below
// runs in a real signed-in session inside one transaction that is rolled back.
//
// Usage: node scripts/verify-finance-reports.mjs [--world staging]
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

const FROM = "2000-01-01", TO = "2100-12-31";

await db.query("begin");
try {
  const org = (await q("select id from orgs where slug = 'oea' and deleted_at is null"))[0];
  const pick = async (role) => (await q(`select id from users where org_id = $1 and role = $2 and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [org.id, role]))[0];
  const approver = await pick("payment_approver");
  // A tenant who has actually paid something, so the narrowing is visible.
  const tenant = (await q(`select u.id from users u where u.org_id = $1 and u.role = 'tenant' and u.deactivated_at is null and u.email not ilike 'probe%'
                             and exists (select 1 from payment_intents i where i.payer_user_id = u.id and i.status = 'paid') order by u.created_at limit 1`, [org.id]))[0];
  if (!approver || !tenant) { console.log("SKIP: needs an OEA Payment Approver and a tenant who has paid"); await db.query("rollback"); process.exit(0); }

  console.log(`Finance reports (0318) on ${world}\n`);

  console.log("A. Money in");
  const truth = await q(`select currency, count(*)::int n, sum(amount_paid) amt from payment_intents where org_id = $1 and status = 'paid' group by currency`, [org.id]);
  const rep = await as(approver.id, () => q(`select currency, count(*)::int n, sum(amount) amt from report_collections($1, $2) group by currency`, [FROM, TO]));
  for (const t of truth) {
    const r = rep.find((x) => x.currency === t.currency);
    check(r && r.n === t.n && near(num(r.amt), num(t.amt)), `${t.currency}: the head of accounts sees every paid collection (${t.n}, ${num(t.amt).toFixed(2)})`);
  }
  const feeCheck = await as(approver.id, () => q(`
    select count(*)::int bad from report_collections($1, $2) r
     where r.purpose = 'Rent' and r.management_fee is not null and r.landlord_net is not null
       and abs((r.management_fee + r.landlord_net) - r.amount) > 0.01`, [FROM, TO]));
  check(feeCheck[0].bad === 0, "for rent, fee + landlord net = the amount received, as posted");
  const tOwn = (await q(`select count(*)::int n from payment_intents where payer_user_id = $1 and status = 'paid'`, [tenant.id]))[0].n;
  const tRep = await as(tenant.id, () => q(`select count(*)::int n from report_collections($1, $2)`, [FROM, TO]));
  check(tRep[0].n === tOwn, `a tenant calling it directly gets their own payments only (${tOwn}), never the organisation's`);

  console.log("\nB. Money out");
  const outTruth = (await q(`select count(*)::int n from remittances where org_id = $1 and status::text in ('sent', 'settled')`, [org.id]))[0].n;
  const outRep = await as(approver.id, () => q(`select count(*)::int n from report_payouts($1, $2)`, [FROM, TO]));
  check(outRep[0].n === outTruth, `the head of accounts sees every released payout (${outTruth})`);
  const tOut = await as(tenant.id, () => q(`select count(*)::int n from report_payouts($1, $2)`, [FROM, TO]));
  check(tOut[0].n === 0, "a tenant sees no payouts");

  console.log("\nC. Property funds");
  const funds = await as(approver.id, () => q(`select account_id, closing, overdrawn from report_property_funds($1, $2)`, [FROM, TO]));
  const bal = await q(`select account_id, natural_balance from ledger_account_balances where org_id = $1 and purpose = 'service_charge_fund'`, [org.id]);
  const mismatch = bal.filter((b) => { const f = funds.find((x) => x.account_id === b.account_id); return !f || !near(num(f.closing), num(b.natural_balance)); });
  check(funds.length > 0 && mismatch.length === 0, `every fund's closing balance equals its ledger balance (${bal.length} funds)`);
  check(funds.every((f) => f.overdrawn === num(f.closing) < 0), "overdrawn is flagged exactly when the closing balance is below zero");

  console.log("\nD. Trial balance");
  const tb = await as(approver.id, () => q(`select currency, sum(debits) dr, sum(credits) cr from report_trial_balance($1) group by currency`, [TO]));
  check(tb.length > 0 && tb.every((r) => near(num(r.dr), num(r.cr))), `debits equal credits in every currency (${tb.map((r) => r.currency).join(", ")})`);
  const tTb = await as(tenant.id, () => q(`select count(*)::int n from report_trial_balance($1) where debits <> 0 or credits <> 0`, [TO]));
  check(tTb[0].n === 0, "a tenant reads no ledger figures from it");

  console.log("\nE. Running balances");
  const drift = (await q(`
    select count(*)::int n from ledger_account_balances lab
     left join lateral (select balance_after from ledger_posting_balances b where b.account_id = lab.account_id
                         order by b.entry_created_at desc, b.entry_id desc, b.posting_id desc limit 1) last on true
     where lab.org_id = $1 and coalesce(last.balance_after, 0) <> lab.natural_balance`, [org.id]))[0].n;
  check(drift === 0, "each account's last running balance equals its balance");
  const tRun = await as(tenant.id, () => q(`select count(*)::int n from ledger_posting_balances`));
  check(tRun[0].n === 0, "a tenant reads no running balances");
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : "\nALL CHECKS PASSED — the reports agree with the ledger, and each seat sees only what it already could");
process.exit(failures ? 1 : 0);
