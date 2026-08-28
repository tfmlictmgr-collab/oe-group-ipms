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

    // ⚠️ REVERSED BY 0218. This asserted `sender_id is null`, on the reasoning
    // that a non-null sender "would wrongly arm the tenant satisfaction prompt".
    // That defended a real invariant through an incidental fact — and the fact
    // cost the FM the ability to find their own work at all: `tickets_select`
    // returns a request to `sender_id = auth.uid()` and the board's "Raised by
    // me" view filters on it, so a work order with no sender belonged to nobody.
    //
    // The invariant is now stated directly instead: a tenant-source rating
    // requires the caller to BE a tenant (0220), and the ticket page offers an
    // FM the quality/compliance half rather than satisfaction. Both are checked
    // below rather than assumed.
    const shape = await tryAsSteps(fm.id, [
      `create temp table _job on commit drop as
         select raise_work_order('${propId}', 'Probe planned work') as id`,
      `select t.sender_id, t.property_id, t.status::text, t.requires_human_review
         from tickets t where t.id = (select id from _job)`,
    ]);
    const row = shape.ok ? shape.steps[1][0] : undefined;
    row && row.sender_id === fm.id && row.property_id === propId
      ? ok("recorded as raised BY THEM and filed against the property — so they can find it again")
      : bad(`wrong shape: ${JSON.stringify(row)}`);

    // The guard that replaces the null. An FM may rate the work they
    // commissioned on quality; they may not file the tenant's satisfaction
    // score for a contractor they hired.
    // ONE transaction: the fixture and the attempt together, because
    // `tryAsSteps` rolls back and a ticket raised in a previous call is gone by
    // the time the next one looks for it. Resolved, with a vendor on it, so the
    // earlier guards in `submit_vendor_evaluation` pass and the one under test
    // is the one that answers.
    const selfRate = await tryAsSteps(fm.id, [
      `create temp table _rate on commit drop as
         select raise_work_order('${propId}', 'Probe self-rated work', null,
                                 'maintenance', 'normal', null,
                                 (select v.id from vendors v
                                   where v.id in (select current_user_scoped_vendor_ids())
                                   limit 1)) as id`,
      `update tickets set status = 'resolved' where id = (select id from _rate)`,
      `select submit_vendor_evaluation((select id from _rate), 'tenant', '[]'::jsonb)`,
    ]);
    if (/no vendor assigned/i.test(selfRate.err ?? "")) {
      // This FM manages no vendor in this org, so the fixture cannot be built
      // and an earlier guard answers first. Not a product failure — the same
      // allowance the payment-verification check below already makes.
      note("no vendor in this FM's scope — the tenant-rating guard is not exercisable here");
    } else {
      !selfRate.ok && /satisfaction rating belongs to the tenant/i.test(selfRate.err ?? "")
        ? ok("and cannot file the TENANT's satisfaction score on their own work order")
        : bad(`an FM filed a tenant-source rating on work they raised: ${selfRate.err ?? "ALLOWED"}`);
    }
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
