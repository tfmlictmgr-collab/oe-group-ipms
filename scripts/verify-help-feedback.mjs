// The help assistant's review loop (0316), proved in real sessions.
//
// Every act runs as a real signed-in user inside ONE transaction that is rolled
// back at the end, so nothing is left behind. Lesson carried from 0216/0264:
// a suite that writes as the service role proves the table and never the
// person's seat — here every check sits in the seat it is about.
//
// Usage: node scripts/verify-help-feedback.mjs --world staging
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
  finally {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true)");
  }
}
async function tryAs(uid, fn) {
  try { return { value: await as(uid, fn) }; }
  catch (e) { return { error: e.message }; }
}

await db.query("begin");
try {
  const pick = async (org, role) => (await q(`select u.id, u.org_id from users u join orgs o on o.id=u.org_id where o.slug=$1 and u.role=$2 and u.email not ilike 'probe%' order by u.created_at limit 1`, [org, role]))[0];
  const tenant = await pick("oea", "tenant");
  const admin = await pick("oea", "admin");
  const otherAdmin = await pick("tfml", "admin");
  if (!tenant || !admin || !otherAdmin) { console.log("SKIP: needs an OEA tenant, an OEA admin and a TFML admin on this world"); await db.query("rollback"); await db.end(); process.exit(0); }

  console.log(`Help feedback (0316) on ${world}\n`);

  console.log("A. A signed-in person's question is kept — masked, with no user id");
  const logged = await as(tenant.id, async () => (await q("select log_help_question($1,'referral',array['Getting in']) id", ["how do I pay? mail me at jo.blogs@example.com or call 0803 123 4567"]))[0].id);
  check(!!logged, "log_help_question returns an id");
  const row = (await q("select * from help_bot_feedback where id=$1", [logged]))[0];
  check(row.org_id === tenant.org_id && row.role === "tenant", "org and role come from the session, not the caller");
  check(!/example\.com|803 123/.test(row.question) && /\[email\]/.test(row.question) && /\[number\]/.test(row.question), `e-mail and phone are masked ("${row.question}")`);
  check(!("user_id" in row), "the row carries no user id");

  console.log("\nB. Who may read it");
  const tSee = await as(tenant.id, async () => (await q("select count(*)::int n from help_bot_feedback"))[0].n);
  check(tSee === 0, "a tenant reads no rows, not even their own");
  const tGaps = await as(tenant.id, async () => (await q("select * from help_bot_gaps(30)")).length);
  check(tGaps === 0, "a tenant calling help_bot_gaps gets an empty set, not a refusal");
  const aGaps = await as(admin.id, async () => await q("select * from help_bot_gaps(30)"));
  check(aGaps.some((g) => g.no_answer >= 1 && g.role === "tenant"), "the organisation's administrator sees the unanswered question");
  const oGaps = await as(otherAdmin.id, async () => (await q("select * from help_bot_gaps(30)")).filter((g) => /how do i pay/.test(g.question)).length);
  check(oGaps === 0, "another organisation's administrator does not see it");

  console.log("\nC. Rating: once, valid, own organisation only");
  await as(tenant.id, async () => q("select rate_help_answer($1, 1::smallint)", [logged]));
  await as(tenant.id, async () => q("select rate_help_answer($1, (-1)::smallint)", [logged]));
  check((await q("select rating from help_bot_feedback where id=$1", [logged]))[0].rating === 1, "a second rating does not overwrite the first");
  const l2 = await as(tenant.id, async () => (await q("select log_help_question('second question','guide',array[]::text[]) id"))[0].id);
  await as(otherAdmin.id, async () => q("select rate_help_answer($1, (-1)::smallint)", [l2]));
  check((await q("select rating from help_bot_feedback where id=$1", [l2]))[0].rating === null, "another organisation cannot rate it");
  await as(tenant.id, async () => q("select rate_help_answer($1, 5::smallint)", [l2]));
  check((await q("select rating from help_bot_feedback where id=$1", [l2]))[0].rating === null, "an out-of-range rating is ignored");
  await as(tenant.id, async () => q("select rate_help_answer($1, (-1)::smallint)", [l2]));
  const aGaps2 = await as(admin.id, async () => await q("select * from help_bot_gaps(30) where question='second question'"));
  check(aGaps2.length === 1 && aGaps2[0].thumbs_down === "1", "a thumbs-down surfaces an answered question for review");

  console.log("\nD. No other way in");
  const direct = await tryAs(tenant.id, async () => q("insert into help_bot_feedback(org_id,role,question,outcome) values ($1,'admin','forged','model')", [tenant.org_id]));
  check(/permission denied|row-level security/i.test(direct.error || ""), `a direct insert is refused for the right reason (${(direct.error || "NOT REFUSED").slice(0, 60)})`);
  const upd = await tryAs(admin.id, async () => q("update help_bot_feedback set question='edited'"));
  check(/permission denied/i.test(upd.error || ""), `an administrator cannot edit what was asked (${(upd.error || "NOT REFUSED").slice(0, 50)})`);
  const grants = (await q(`select p.proname,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') svc
    from pg_proc p where p.proname in ('log_help_question','rate_help_answer','help_bot_gaps','purge_help_bot_feedback')`));
  check(grants.length === 4 && grants.every((g) => !g.anon), "no function is reachable by anon");
  const purge = grants.find((g) => g.proname === "purge_help_bot_feedback");
  check(purge && !purge.auth && purge.svc, "the purge is service_role only");

  console.log("\nE. Retention");
  await db.query("update help_bot_feedback set created_at = now() - interval '100 days' where id=$1", [logged]);
  const deleted = (await q("select purge_help_bot_feedback(90) n"))[0].n;
  check(deleted >= 1 && (await q("select 1 from help_bot_feedback where id=$1", [logged])).length === 0, "a question older than 90 days is deleted");
  check((await q("select 1 from help_bot_feedback where id=$1", [l2])).length === 1, "a recent one is kept");
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : "\nALL CHECKS PASSED — the help review loop is masked, scoped, rate-limited by the database, and expires");
process.exit(failures ? 1 : 0);
