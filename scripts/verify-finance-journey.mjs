// The finance lead's documented journey, across every organisation:
//   reconcile the ledger (match payments to the work they paid for) →
//   batch-approve vendor payouts → remit to owners → generate reports (P&L and
//   statements) → multi-entity consolidation.
//
// Four things this suite exists to hold down, each of which was wrong:
//
//   * ⚠️ A BATCH MUST NOT BE A SHORTCUT PAST THE GATE, and must not be
//     all-or-nothing. Section B approves a mixed batch as a finance approver:
//     some below the threshold, one above it, one not even at `recommended`.
//     The right answer is a partial success with a reason per row — a single
//     multi-row UPDATE would have refused the lot.
//   * ⚠️ THE APP WAS STRICTER THAN THE BOARD. `approvePayment` refused an
//     executive above the threshold ("ask an administrator") for a payment
//     `enforce_payment_transition` accepts from them — decision 9 gave the MD
//     and Managing Partner exactly that power. Section C proves the database
//     allows it, which is what makes the application fix correct rather than a
//     loosening.
//   * ⚠️ THE OWNER COULD NOT BE PAID. `create_rent_remittance` has existed
//     since 0092b and was called by nothing outside the verification scripts.
//   * ⚠️ CONSOLIDATION IS A B1 CROSSING. Section F is the one that matters most:
//     a brand administrator must receive an EMPTY SET, never a refusal, because
//     a refusal confirms the other organisations exist.
//
// Usage: node scripts/verify-finance-journey.mjs
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

/**
 * Several statements in ONE transaction, rolled back.
 *
 * `{ service: true, sql }` drops to the service role (what a webhook or a
 * seeding job is); `{ as: id, sql }` speaks as that user. Fixtures are created
 * as service role throughout — a finance user cannot mint a recommended payment
 * out of nothing, and a suite that tried would be testing the wrong thing.
 *
 * ⚠️ Separate statements, never a CTE: a row created inside a CTE is invisible
 * to a SELECT in the same statement, and an earlier suite in this codebase
 * reported a product bug that was really that.
 */
async function steps(items) {
  await db.query("begin");
  try {
    const out = [];
    for (const item of items) {
      if (item.service) {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
      } else if (item.as) {
        await db.query("set local role authenticated");
        await db.query(claims(item.as));
      }
      if (item.sql) {
        out.push((await db.query(item.sql)).rows);
        // ⚠️ A temp table created by the superuser is NOT readable by
        // `authenticated`. Without this grant every fixture handoff fails with
        // "permission denied for table _p" — which the first run of this suite
        // reported as "A BATCH APPROVED AN UNGATED PAYMENT", an alarming
        // sentence about a plumbing fault. Granted here, once, rather than
        // remembered at each call site.
        const made = /create temp table (_\w+)/i.exec(item.sql);
        if (made) await db.query(`grant all on ${made[1]} to authenticated`);
      }
    }
    await db.query("rollback");
    return { ok: true, steps: out };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 160) };
  }
}

async function asUser(userId, sql) {
  const r = await steps([{ as: userId, sql }]);
  return r.ok ? { ok: true, rows: r.steps[0] } : { ok: false, err: r.err };
}

const { data: orgs } = await svc.from("orgs")
  .select("id, name, slug, is_platform_operator").is("deleted_at", null).order("slug");
const tenantOrgs = (orgs ?? []).filter((o) => !o.is_platform_operator);

console.log("Finance lead journey — every step, every organisation\n");

for (const o of tenantOrgs) {
  const { data: fin } = await svc.from("users").select("id, email")
    .eq("org_id", o.id).eq("role", "finance_approver").is("deactivated_at", null)
    .limit(1).maybeSingle();
  if (!fin) { note(`${o.slug}: no finance_approver — skipped`); continue; }

  const { data: vendor } = await svc.from("vendors")
    .select("id").eq("org_id", o.id).limit(1).maybeSingle();

  console.log(`── ${o.slug} ──`);

  // ⚠️ A missing vendor skips the VENDOR sections, not the organisation.
  //
  // The first version of this suite did `continue` here, and the cost was
  // invisible: OEA is the only org with a lease, and OEA has no vendor — so
  // the whole org was skipped and section F's rule ("a landlord is paid what
  // was received, never what was billed") was never once exercised, on any
  // org, while the suite reported ALL CHECKS PASSED. A skip that silently
  // takes the most important assertion with it is worse than a failure.

  // ── A. What the caller may approve ──────────────────────────────────────
  const lim = await asUser(fin.id, `select * from my_approval_limit()`);
  const l = lim.ok ? lim.rows[0] : undefined;
  l?.may_approve === true && l?.unlimited === false
    ? ok(`finance may approve, up to ₦${Number(l.threshold).toLocaleString()}`)
    : bad(`wrong approval limit for finance: ${JSON.stringify(l ?? lim.err)}`);

  // ── B. A mixed batch ────────────────────────────────────────────────────
  //
  // Three payments: two approvable, one above the threshold, one still at
  // `verified` and therefore not ready. A single multi-row UPDATE would refuse
  // all three.
  const threshold = Number(l?.threshold ?? 1000000);
  if (!vendor) note("no vendor on this org — the approval and invoice sections need one");
  const mk = (amount, status, ref) =>
    `insert into payments (org_id, vendor_id, amount, status, service_verified_at,
                           performance_validated, invoice_reference)
     values ('${o.id}', '${vendor.id}', ${amount}, '${status}',
             now(), true, 'PROBEFIN-${ref}') returning id`;

  const batch = !vendor ? null : await steps([
    { service: true, sql: `create temp table _p (id uuid, tag text) on commit drop` },
    { service: true, sql: `with n as (${mk(1000, "recommended", "small1")}) insert into _p select id, 'small1' from n` },
    { service: true, sql: `with n as (${mk(2000, "recommended", "small2")}) insert into _p select id, 'small2' from n` },
    { service: true, sql: `with n as (${mk(threshold + 500000, "recommended", "big")}) insert into _p select id, 'big' from n` },
    { service: true, sql: `with n as (${mk(3000, "verified", "notready")}) insert into _p select id, 'notready' from n` },
    { as: fin.id, sql:
      `select p.tag, r.approved, r.reason
         from _p p
         join approve_payments((select array_agg(id) from _p)) r on r.payment_id = p.id
        order by p.tag` },
  ]);

  if (!batch) {
    // sections B and C need a vendor; F, E and G below do not
  } else if (!batch.ok) {
    bad(`the batch itself failed: ${batch.err}`);
  } else {
    const by = Object.fromEntries(batch.steps[5].map((r) => [r.tag, r]));
    by.small1?.approved === true && by.small2?.approved === true
      ? ok("approves the two within the threshold")
      : bad(`the approvable ones were refused: ${JSON.stringify([by.small1, by.small2])}`);

    by.big?.approved === false && /administrator or an executive/i.test(by.big?.reason ?? "")
      ? ok("refuses the one above the threshold, in the gate's own words")
      : bad(`the over-threshold payment was not refused correctly: ${JSON.stringify(by.big)}`);

    by.notready?.approved === false
      ? ok("and skips one that is not at 'recommended'")
      : bad(`a payment not awaiting approval was approved: ${JSON.stringify(by.notready)}`);

    // The whole point: a refusal in the middle did NOT roll back the rest.
    by.small1?.approved && by.small2?.approved && !by.big?.approved
      ? ok("PARTIAL SUCCESS — one refusal did not undo the others")
      : bad("the batch behaved as all-or-nothing");
  }

  // The gate is not skipped just because the call is a batch.
  const ungated = !vendor ? null : await steps([
    { service: true, sql: `create temp table _u (id uuid) on commit drop` },
    { service: true, sql:
      `with n as (insert into payments (org_id, vendor_id, amount, status,
                                        service_verified_at, performance_validated, invoice_reference)
                  values ('${o.id}', '${vendor.id}', 1000, 'recommended', null, false, 'PROBEFIN-ungated')
                  returning id) insert into _u select id from n` },
    { as: fin.id, sql: `select approved, reason from approve_payments(array(select id from _u))` },
  ]);
  if (ungated) {
    const u = ungated.ok ? ungated.steps[2][0] : undefined;
    u?.approved === false
      ? ok("a payment through no gate is refused even inside a batch")
      : bad(`!!! A BATCH APPROVED AN UNGATED PAYMENT: ${JSON.stringify(u ?? ungated.err)}`);
  }

  // ── C. The executive's above-threshold approval ─────────────────────────
  const { data: exec } = await svc.from("users").select("id, email")
    .eq("org_id", o.id).eq("role", "executive").is("deactivated_at", null)
    .limit(1).maybeSingle();
  if (!exec || !vendor) {
    note("no executive or no vendor on this org — decision-9 escalation not testable");
  } else {
    const el = await asUser(exec.id, `select * from my_approval_limit()`);
    el.ok && el.rows[0]?.unlimited === true
      ? ok("an executive is above the threshold — decision 9, and the app used to say otherwise")
      : bad(`the executive is not exempt: ${JSON.stringify(el.rows?.[0] ?? el.err)}`);

    const bigExec = await steps([
      { service: true, sql: `create temp table _e (id uuid) on commit drop` },
      { service: true, sql: `with n as (${mk(threshold + 900000, "recommended", "execbig")}) insert into _e select id from n` },
      { as: exec.id, sql: `select approved, reason from approve_payments(array(select id from _e))` },
    ]);
    bigExec.ok && bigExec.steps[2][0]?.approved === true
      ? ok("and can approve above it — the MD is who the escalation was for")
      : bad(`the executive was refused: ${JSON.stringify(bigExec.steps?.[2]?.[0] ?? bigExec.err)}`);

    // Oversight authorises; finance disburses. This must never soften.
    const remit = await steps([
      { service: true, sql: `create temp table _r (id uuid) on commit drop` },
      { service: true, sql:
        `with n as (insert into payments (org_id, vendor_id, amount, status, service_verified_at,
                                          performance_validated, approved_at, invoice_reference)
                    values ('${o.id}', '${vendor.id}', 5000, 'approved', now(), true, now(), 'PROBEFIN-remit')
                    returning id) insert into _r select id from n` },
      { as: exec.id, sql: `update payments set status = 'remitted' where id = (select id from _r) returning id` },
    ]);
    // ⚠️ Three outcomes, not two. "Refused" is only correct when it was refused
    // for THIS reason — an unrelated failure (a broken fixture, a missing
    // grant) would otherwise read as a passing security check, or, as it did on
    // this suite's first run, as a screaming false alarm.
    if (remit.ok) {
      bad("!!! AN EXECUTIVE REMITTED A PAYMENT");
    } else if (/only finance or an administrator may remit/i.test(remit.err ?? "")) {
      ok("and still cannot remit — oversight authorises, finance disburses");
    } else {
      bad(`the remit attempt failed for an unrelated reason, so nothing was proven: ${remit.err}`);
    }
  }

  // ── D. A payment names the work it paid for ─────────────────────────────
  const trace = await asUser(fin.id,
    `select count(*)::int n, count(*) filter (where unmatched_and_paid)::int unmatched
       from payment_work_order_trace`);
  trace.ok
    ? ok(`traces ${trace.rows[0].n} payment(s), ${trace.rows[0].unmatched} paid with no work order`)
    : bad(`cannot read the payment/work-order trace: ${trace.err}`);

  // An invoice cannot be attached to a job the vendor did not do.
  const { data: foreignJob } = vendor
    ? await svc.from("tickets")
        .select("id, assigned_vendor_id").eq("org_id", o.id)
        .not("assigned_vendor_id", "is", null).neq("assigned_vendor_id", vendor.id)
        .limit(1).maybeSingle()
    : { data: null };
  if (!foreignJob || !vendor) {
    note("no job belonging to another vendor — the mis-attachment check needs one");
  } else {
    const wrong = await steps([
      { service: true, sql:
        `insert into payments (org_id, vendor_id, ticket_id, amount, status, invoice_reference)
         values ('${o.id}', '${vendor.id}', '${foreignJob.id}', 1000, 'pending_verification', 'PROBEFIN-wrongjob')` },
    ]);
    !wrong.ok && /not assigned to this vendor/i.test(wrong.err ?? "")
      ? ok("an invoice cannot claim another vendor's job")
      : bad(`an invoice was attached to a job the vendor did not do: ${wrong.err ?? "allowed"}`);
  }

  // ── E. Reports ──────────────────────────────────────────────────────────
  const pnl = await asUser(fin.id,
    `select count(*)::int n, count(distinct currency)::int ccy
       from org_profit_and_loss('2000-01-01', '2100-01-01')`);
  pnl.ok
    ? ok(`produces a P&L: ${pnl.rows[0].n} account line(s) across ${pnl.rows[0].ccy} currency/currencies`)
    : bad(`cannot produce a P&L: ${pnl.err}`);

  // ⚠️ The 0103 lesson, asserted rather than assumed: every row must carry a
  // currency, so nothing downstream can sum across them by accident.
  const ccy = await asUser(fin.id,
    `select count(*)::int n from org_profit_and_loss('2000-01-01','2100-01-01') where currency is null`);
  ccy.ok && ccy.rows[0].n === 0
    ? ok("and every line names its currency — nothing can be summed across them by accident")
    : bad(`${ccy.rows?.[0]?.n} P&L line(s) with no currency`);

  // ── F. Payouts to owners ────────────────────────────────────────────────
  const cands = await asUser(fin.id, `select count(*)::int n from landlord_payout_candidates()`);
  cands.ok
    ? ok(`sees ${cands.rows[0].n} landlord payout candidate(s)`)
    : bad(`cannot read payout candidates: ${cands.err}`);

  // ⚠️ The rule that matters: money DEMANDED is not money HELD. A payout
  // candidate must appear only once a tenant has actually paid.
  //
  // ⚠️ This section builds its OWN lease, unit and rent charge rather than
  // looking for one. The first version searched the seed data, found none on
  // any org, printed "not testable here" four times, and reported ALL CHECKS
  // PASSED — so the single most important rule in the payout path was never
  // once exercised while the suite looked green. A check that quietly opts out
  // when the data is thin is not a check.
  const { data: owned } = await svc.from("property_stakeholders")
    .select("property_id, user_id").eq("org_id", o.id).eq("relation", "owner")
    .limit(1).maybeSingle();

  if (!owned) {
    note("no property with a recorded owner — the payout rule needs one");
  } else {
    const build = (amountPaid) => [
      { service: true, sql: `create temp table _u (id uuid) on commit drop` },
      { service: true, sql:
        `with n as (insert into units (org_id, property_id, label)
                    values ('${o.id}', '${owned.property_id}', 'PROBEFIN-unit')
                    returning id) insert into _u select id from n` },
      { service: true, sql: `create temp table _l (id uuid) on commit drop` },
      { service: true, sql:
        // ⚠️ No `landlord_user_id` on `leases` — there is no such column. The
        // landlord of a property is `property_stakeholders.relation = 'owner'`,
        // which is exactly what `landlord_payout_candidates` joins through, so
        // the fixture must establish ownership the same way rather than
        // inventing a field. (The first attempt assumed the column and the
        // database said no, which is the check working.)
        `with n as (insert into leases (org_id, property_id, unit_id,
                                        start_date, end_date, status, rent_amount, currency)
                    values ('${o.id}', '${owned.property_id}', (select id from _u),
                            current_date, current_date + 365,
                            'active', 500000, 'NGN')
                    returning id) insert into _l select id from n` },
      { service: true, sql:
        `insert into rent_charges (org_id, lease_id, period_start, period_end, due_date,
                                   amount, amount_paid, currency, status,
                                   management_fee_pct, management_fee_amount,
                                   admin_fee_amount, landlord_net_amount)
         values ('${o.id}', (select id from _l), current_date, current_date + 365,
                 current_date, 500000, ${amountPaid}, 'NGN',
                 '${amountPaid > 0 ? "paid" : "due"}', 10, 50000, 0, 450000)` },
      { as: fin.id, sql:
        `select coalesce(sum(collected),0)::numeric total from landlord_payout_candidates()` },
    ];

    const demanded = await steps(build(0));
    const collected = await steps(build(500000));

    if (!demanded.ok || !collected.ok) {
      bad(`could not build the payout fixture: ${demanded.err ?? collected.err}`);
    } else {
      const d = Number(demanded.steps[5][0].total);
      const c = Number(collected.steps[5][0].total);
      c > d
        ? ok(`a COLLECTED demand becomes payable (₦${c.toLocaleString()}); a merely demanded one does not (₦${d.toLocaleString()})`)
        : bad(`demanded ${d} vs collected ${c} — a landlord could be paid money no tenant handed over`);
      // And the figure must be the LANDLORD'S share, not the gross rent — the
      // fee was already taken at collection, and paying out the gross would
      // hand the landlord the org's own fee income.
      c === 450000
        ? ok("and it is the landlord's net share, not the gross rent")
        : bad(`the payable figure is ${c}, expected the net 450000 — the fee is being paid away`);
    }
  }

  // ── G. What stays shut ──────────────────────────────────────────────────
  const { data: fm } = await svc.from("users").select("id")
    .eq("org_id", o.id).eq("role", "facility_manager").is("deactivated_at", null)
    .limit(1).maybeSingle();
  if (fm) {
    const fmPnl = await asUser(fm.id,
      `select count(*)::int n from org_profit_and_loss('2000-01-01','2100-01-01')`);
    fmPnl.ok && fmPnl.rows[0].n === 0
      ? ok("an FM/PM gets no P&L — B7 holds")
      : bad(`AN FM SAW ${fmPnl.rows?.[0]?.n} P&L LINE(S)`);

    const fmPayouts = await asUser(fm.id, `select count(*)::int n from landlord_payout_candidates()`);
    fmPayouts.ok && fmPayouts.rows[0].n === 0
      ? ok("and no landlord payouts")
      : bad(`AN FM SAW ${fmPayouts.rows?.[0]?.n} PAYOUT CANDIDATE(S)`);
  }

  console.log("");
}

// ── H. Consolidation is the operator's, and nobody else's ─────────────────
//
// ⚠️ The B1 crossing. The assertion is not merely "a brand admin gets no data"
// — it is that they get an EMPTY SET rather than a REFUSAL. A refusal confirms
// there are other organisations worth refusing access to, which is the half of
// B1 people forget: "or existence".
console.log("── consolidation boundary ──");
{
  const operator = (orgs ?? []).find((o) => o.is_platform_operator);
  if (!operator) {
    note("no platform operator org — consolidation not testable");
  } else {
    const { data: opAdmin } = await svc.from("users").select("id, email")
      .eq("org_id", operator.id).eq("role", "admin").is("deactivated_at", null)
      .limit(1).maybeSingle();

    if (!opAdmin) {
      note("no operator administrator — consolidation not testable");
    } else {
      const seen = await asUser(opAdmin.id,
        `select count(*)::int n, count(distinct org_id)::int orgs
           from operator_consolidated_position('2000-01-01','2100-01-01')`);
      seen.ok && seen.rows[0].orgs > 0
        ? ok(`the operator consolidates ${seen.rows[0].orgs} client organisation(s)`)
        : bad(`the operator sees nothing to consolidate: ${JSON.stringify(seen.rows?.[0] ?? seen.err)}`);

      // ⚠️ The crossing is CONFINED to the one function. An operator admin
      // reads zero rows of `ledger_entries` directly — no cross-org policy was
      // added, and none should ever be. If this ever returns a non-zero count,
      // somebody has widened a policy instead of extending the audited
      // function, which is exactly what decision 7 forbids.
      const raw = await asUser(opAdmin.id, `select count(*)::int n from ledger_entries`);
      raw.ok && raw.rows[0].n === 0
        ? ok("and reads no org's raw ledger — the crossing is the function, not a policy")
        : bad(`THE OPERATOR READS ${raw.rows?.[0]?.n} LEDGER ENTRIES DIRECTLY — a cross-org policy exists`);

      // The page's own default range, not just a wide one. A report that works
      // over 2000–2100 and shows nothing over "this year" is a broken report.
      const thisYear = await asUser(opAdmin.id,
        `select count(*)::int n from operator_consolidated_position(
           date_trunc('year', current_date)::date, current_date)`);
      thisYear.ok && thisYear.rows[0].n > 0
        ? ok("and consolidates over the year-to-date range the page actually asks for")
        : bad("the consolidation is empty over the page's own default period");

      // The operator org is the holder of the view, not an entity in it.
      const selfIncluded = await asUser(opAdmin.id,
        `select count(*)::int n from operator_consolidated_position('2000-01-01','2100-01-01')
          where org_id = '${operator.id}'`);
      selfIncluded.ok && selfIncluded.rows[0].n === 0
        ? ok("and does not consolidate itself")
        : bad("the operator org appears inside its own consolidation");
    }

    for (const o of tenantOrgs) {
      for (const role of ["admin", "finance_approver", "executive"]) {
        const { data: u } = await svc.from("users").select("id")
          .eq("org_id", o.id).eq("role", role).is("deactivated_at", null)
          .limit(1).maybeSingle();
        if (!u) continue;

        const r = await asUser(u.id,
          `select count(*)::int n from operator_consolidated_position('2000-01-01','2100-01-01')`);
        // BOTH halves. `r.ok` proves it did not raise; `n === 0` proves it
        // returned nothing. Either one alone would pass for the wrong reason.
        r.ok && r.rows[0].n === 0
          ? ok(`${o.slug} ${role}: empty set, not a refusal`)
          : bad(
              r.ok
                ? `!!! ${o.slug} ${role} CONSOLIDATED ${r.rows[0].n} ROW(S) ACROSS ORGS`
                : `${o.slug} ${role} got a REFUSAL, which confirms the other orgs exist: ${r.err}`
            );
      }
    }
  }
}

await db.end();

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — finance can approve in bulk, pay owners and report; the gate holds per row, and only the operator consolidates."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
