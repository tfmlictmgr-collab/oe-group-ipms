// Test records are marked, scoped, unforgeable, and change no money (0321-0323).
//
// Inside ONE rolled-back transaction on a real organisation:
//   A. marking a person cascades to what hangs off them, ledger entries included;
//   B. nobody signed in can mark, unmark or forge a marker; only the function writes;
//   C. a marker is visible to its own organisation only;
//   D. the reports flag marked rows; the ledger's arithmetic does not move.
//
// Usage: node scripts/verify-test-records.mjs [--world staging]
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
  catch (e) { check(re.test(e.message), `${label} (${e.message.slice(0, 70)})`); }
}

await db.query("begin");
try {
  const org = (await q("select id from orgs where slug = 'oea' and deleted_at is null"))[0];
  const other = (await q("select id from orgs where slug = 'tfml' and deleted_at is null"))[0];
  const pick = async (o, role) => (await q(`select id from users where org_id = $1 and role = $2 and email not ilike 'probe%' and deactivated_at is null order by created_at limit 1`, [o, role]))[0];
  const admin = await pick(org.id, "admin");
  const approver = await pick(org.id, "payment_approver");
  const otherAdmin = other ? await pick(other.id, "admin") : null;
  const tenant = (await q(`select u.id from users u where u.org_id = $1 and u.role = 'tenant' and u.email not ilike 'probe%'
                            and exists (select 1 from payment_intents i where i.payer_user_id = u.id and i.status = 'paid') order by u.created_at limit 1`, [org.id]))[0];
  if (!admin || !approver || !tenant) { console.log("SKIP: needs an OEA admin, a Payment Approver and a tenant who has paid"); await db.query("rollback"); process.exit(0); }

  console.log(`Test records (0321–0323) on ${world}\n`);
  const posBefore = (await q("select funds_held, funds_owed, unallocated from client_funds_position where org_id = $1 and currency = 'NGN'", [org.id]))[0];

  console.log("A. Marking cascades");
  const marked = await q("select * from mark_test_records($1, $2::uuid[], '{}'::uuid[], '{}'::uuid[], 'verify suite')", [org.id, [tenant.id]]);
  const n = (t) => Number(marked.find((m) => m.entity_type === t)?.marked ?? 0);
  check(n("user") === 1, "the person is marked");
  const paidIntents = (await q("select count(*)::int n from payment_intents where payer_user_id = $1", [tenant.id]))[0].n;
  check(n("payment_intent") === paidIntents, `every collection they paid is marked (${paidIntents})`);
  const entries = (await q(`select count(*)::int n from ledger_entries e join payment_intents i on i.id = e.entity_id
                             where e.entity_type = 'payment_intent' and i.payer_user_id = $1`, [tenant.id]))[0].n;
  check(n("ledger_entry") >= entries, `the ledger entries those collections posted are marked (${entries}+)`);
  const again = await q("select * from mark_test_records($1, $2::uuid[], '{}'::uuid[], '{}'::uuid[], 'again')", [org.id, [tenant.id]]);
  const total = (await q("select count(*)::int n from test_records where org_id = $1 and entity_type = 'user' and entity_id = $2", [org.id, tenant.id]))[0].n;
  check(again.length > 0 && total === 1, "marking twice does not duplicate a marker");

  console.log("\nB. Only the function writes");
  await refused(admin.id, "insert into test_records (org_id, entity_type, entity_id) values ($1, 'user', $2)", [org.id, admin.id], /permission denied/, "an administrator cannot add a marker directly");
  await refused(admin.id, "delete from test_records where org_id = $1", [org.id], /permission denied/, "an administrator cannot remove markers");
  await refused(admin.id, "select mark_test_records($1, $2::uuid[])", [org.id, [admin.id]], /permission denied/, "an administrator cannot call the marking function");
  await refused(tenant.id, "select mark_test_records($1, $2::uuid[])", [org.id, [tenant.id]], /permission denied/, "a tenant cannot hide their own records");

  console.log("\nC. Visible to its own organisation only");
  const mine = await as(admin.id, () => q("select count(*)::int n from test_records where entity_id = $1", [tenant.id]));
  check(mine[0].n === 1, "the organisation's administrator reads the marker");
  if (otherAdmin) {
    const theirs = await as(otherAdmin.id, () => q("select count(*)::int n from test_records where entity_id = $1", [tenant.id]));
    check(theirs[0].n === 0, "another organisation's administrator does not");
  }

  console.log("\nD. Reports flag it; the money does not move");
  const flagged = await as(approver.id, () => q(`select count(*) filter (where is_test)::int t, count(*)::int a from report_collections('2000-01-01', '2100-12-31')`));
  check(flagged[0].t === paidIntents, `report_collections flags exactly their collections as test (${flagged[0].t} of ${flagged[0].a})`);
  const posAfter = (await q("select funds_held, funds_owed, unallocated from client_funds_position where org_id = $1 and currency = 'NGN'", [org.id]))[0];
  check(JSON.stringify(posBefore) === JSON.stringify(posAfter), "the segregation position is identical before and after marking");
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : "\nALL CHECKS PASSED — test records are marked by the clean-up alone, seen only by their organisation, and change no money");
process.exit(failures ? 1 : 0);
