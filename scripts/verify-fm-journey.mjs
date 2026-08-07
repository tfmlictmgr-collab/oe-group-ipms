// The FM/PM's documented journey, across every organisation:
//   see and manage properties → dispatch vendors → verify service (the gate)
//   → manage the asset/unit register → review tenant applications → rent roll
//   → and raise work of their own.
//
// ⚠️ Two of those were broken in ways only this role could hit, which is
// exactly why a suite written from an ADMIN's seat would have passed:
//
//   * Adding a property failed in every org. Not the insert — the RETURNING.
//     Postgres applies SELECT policies to a RETURNING clause, an FM holds no
//     `properties.read_all` (B7 scopes them to assigned properties), and a
//     property created a microsecond ago has no stakeholder row. So they
//     could not read back what they had just made, and the statement failed.
//     An admin never sees this: `read_all` makes their read independent of
//     the assignment.
//   * Raising work at all. Every route into `tickets` assumed a reporter, so
//     planned maintenance had nowhere to go.
//
// Usage: node scripts/verify-fm-journey.mjs
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

/** Runs SQL as a user and ROLLS BACK — nothing this suite does persists. */
async function tryAs(userId, sql) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    const r = await db.query(sql);
    await db.query("rollback");
    return { ok: true, rows: r.rows, n: r.rowCount };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 90) };
  }
}

/**
 * Several statements in ONE transaction, then rolled back.
 *
 * ⚠️ Needed because a row created inside a CTE is NOT visible to a SELECT in
 * the same statement — Postgres evaluates both against the snapshot taken at
 * statement start, and `current_user_property_ids()` is STABLE and cached with
 * it. The first version of this suite used a CTE and reported "created but
 * unreadable to its creator" on every org: a test artefact that read exactly
 * like the product bug it was written to catch. Same transaction, separate
 * statements, is what actually reproduces what the app does.
 */
async function tryAsSteps(userId, sqls) {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: "authenticated" }).replace(/'/g, "''")}'`
    );
    const out = [];
    for (const sql of sqls) out.push((await db.query(sql)).rows);
    await db.query("rollback");
    return { ok: true, steps: out };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 90) };
  }
}

const { data: orgs } = await svc.from("orgs")
  .select("id, name, slug, is_platform_operator").is("deleted_at", null).order("slug");
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

console.log("FM/PM journey — every step, every organisation\n");

for (const o of tenantOrgs) {
  const { data: fm } = await svc.from("users").select("id, email")
    .eq("org_id", o.id).eq("role", "facility_manager").is("deactivated_at", null)
    .limit(1).maybeSingle();
  if (!fm) { note(`${o.slug}: no facility_manager user — skipped`); continue; }

  console.log(`── ${o.slug} ──`);

  // 1. See and manage properties.
  const seen = await tryAs(fm.id, `select count(*)::int n from properties`);
  seen.ok ? ok(`sees ${seen.rows[0].n} propert(y/ies)`) : bad(`cannot read properties: ${seen.err}`);

  const created = await tryAs(fm.id,
    `select create_property('PROBEFM Court', '1 Probe Road', null, null) as id`);
  created.ok && created.rows[0]?.id
    ? ok("CREATES a property — the RETURNING failure is closed")
    : bad(`cannot create a property: ${created.err}`);

  // The half that was missing: they must be able to read it back, in the same
  // breath. Asserted together, because the create only failed BECAUSE of the
  // read — testing them apart would miss it entirely.
  const roundTrip = await tryAsSteps(fm.id, [
    `create temp table _made on commit drop as
       select create_property('PROBEFM RoundTrip', null, null, null) as id`,
    `select (select count(*)::int from properties p where p.id = (select id from _made)) as n`,
  ]);
  roundTrip.ok && roundTrip.steps[1][0]?.n === 1
    ? ok("and reads it straight back — the creator is attached as its manager")
    : bad(`created but unreadable to its creator: ${roundTrip.err ?? "0 rows"}`);

  // 7. Raise work proactively — the step that did not exist.
  const prop = await tryAs(fm.id, `select id from properties limit 1`);
  const propId = prop.rows?.[0]?.id;
  if (!propId) {
    note("no property in scope — cannot test raising work");
  } else {
    const raised = await tryAs(fm.id,
      `select raise_work_order('${propId}', 'Quarterly generator service') as id`);
    raised.ok && raised.rows[0]?.id
      ? ok("RAISES work of their own — planned maintenance now has somewhere to go")
      : bad(`cannot raise work: ${raised.err}`);

    // sender_id must stay null: there is no reporter, and a non-null one would
    // make planned work look like a complaint AND wrongly arm the tenant
    // satisfaction prompt on resolve (0104).
    const shape = await tryAsSteps(fm.id, [
      `create temp table _job on commit drop as
         select raise_work_order('${propId}', 'Probe planned work') as id`,
      `select t.sender_id, t.property_id, t.status::text, t.requires_human_review
         from tickets t where t.id = (select id from _job)`,
    ]);
    const row = shape.ok ? shape.steps[1][0] : undefined;
    row && row.sender_id === null && row.property_id === propId
      ? ok("with no reporter and filed against the property — not a complaint about themselves")
      : bad(`wrong shape: ${JSON.stringify(row)}`);
    row && row.requires_human_review === false && row.status === "open"
      ? ok("open and not flagged for triage — a person wrote it deliberately")
      : bad(`unexpected status/review flag: ${JSON.stringify(row)}`);

    // Scope is enforced, not assumed.
    const { data: foreign } = await svc.from("properties")
      .select("id").neq("org_id", o.id).limit(1).maybeSingle();
    if (foreign) {
      const cross = await tryAs(fm.id,
        `select raise_work_order('${foreign.id}', 'Work on a property I do not manage')`);
      !cross.ok
        ? ok("cannot raise work on a property they do not manage")
        : bad("!!! RAISED WORK ON ANOTHER ORGANISATION'S PROPERTY");
    }
  }

  // 3. The gate: verify yes, approve no.
  const { data: pay } = await svc.from("payments")
    .select("id").eq("org_id", o.id).limit(1).maybeSingle();
  if (!pay) { note("no payment on this org — gate step not testable"); }
  else {
    // ⚠️ An FM's write on payments is scoped to vendors they manage
    // (`current_user_scoped_vendor_ids()`). Zero rows on a payment for a
    // vendor outside their scope is CORRECT, not a failure — so establish
    // scope first rather than reading a right refusal as a bug.
    const scoped = await tryAs(fm.id,
      `select count(*)::int n from payments p
        where p.id = '${pay.id}'
          and p.vendor_id in (select current_user_scoped_vendor_ids())`);
    const inScope = scoped.ok && scoped.rows[0]?.n === 1;
    if (!inScope) {
      note("that payment's vendor is outside this FM's scope — verification correctly not theirs");
    } else {
      const verify = await tryAs(fm.id,
        `update payments set service_verified_at = now() where id = '${pay.id}' returning id`);
      verify.ok && verify.n === 1
        ? ok("verifies service delivery — their half of the B4 gate")
        : bad(`cannot verify service on a vendor they manage: ${verify.err ?? "0 rows"}`);
    }

    const approve = await tryAs(fm.id,
      `update payments set status = 'approved', approved_by = '${fm.id}' where id = '${pay.id}' returning id`);
    (approve.ok && approve.n === 0) || !approve.ok
      ? ok("and cannot approve it — authorising the money is finance's, not theirs")
      : bad("!!! AN FM APPROVED A PAYMENT");
  }

  // 4/5/6. The registers they oversee.
  for (const [label, sql] of [
    ["the asset register", "select count(*)::int n from assets"],
    ["the unit register", "select count(*)::int n from units"],
    ["tenant applications", "select count(*)::int n from tenant_applications"],
    ["leases and the rent roll", "select count(*)::int n from leases"],
  ]) {
    const r = await tryAs(fm.id, sql);
    r.ok ? ok(`reads ${label}`) : bad(`cannot read ${label}: ${r.err}`);
  }

  // And the boundary that must hold whatever else is true.
  const ledger = await tryAs(fm.id, `select count(*)::int n from ledger_entries`);
  ledger.ok && ledger.rows[0].n === 0
    ? ok("reads no client-funds ledger — B7 holds")
    : bad(`FM SAW ${ledger.rows?.[0]?.n} LEDGER ENTRIES`);

  console.log("");
}

await db.end();

console.log(
  failures === 0
    ? "\x1b[32mALL CHECKS PASSED\x1b[0m — an FM/PM can run their properties, raise their own work, and still cannot pay anyone."
    : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
