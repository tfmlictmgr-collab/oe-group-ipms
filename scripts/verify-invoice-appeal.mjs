// The invoice lifecycle from the vendor's side: who acts at each gate, and what
// happens when an invoice is refused.
//
// ⚠️ Written from four questions asked of the live build, three of which had no
// good answer:
//
//   * "Who does the performance check, who approves, who remits?" — answerable
//     from `enforce_payment_transition`, and asserted here so the answer stays
//     true rather than being re-read from a migration each time.
//   * "When a vendor's invoice is rejected, how can it be appealed?" — it could
//     not be. `rejected` had no outgoing transition, so an invoice refused in
//     error was terminal, for work that had genuinely been done.
//   * A rejection recorded NO REASON anywhere: `payments` had no such column.
//   * And nobody was told. Approval notifies the vendor; refusal notified no one.
//
// Every fixture is created as service role and rolled back, so no real invoice
// is refused by running this.
//
// Usage: node scripts/verify-invoice-appeal.mjs
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

const asClaims = (id) =>
  `set local request.jwt.claims = '${JSON.stringify({ sub: id, role: "authenticated" })}'`;

/**
 * Build an invoice at a given status as SERVICE ROLE, then act on it as a user.
 * Always rolled back.
 */
async function scenario(orgId, vendorId, status, actorId, sql, extra = "") {
  // ⚠️ DECLARED OUT HERE, not inside the `try`.
  //
  // These were `let` inside the try block, and a `catch` is a SEPARATE scope —
  // it cannot see them. So the first statement that threw died with
  // `ReferenceError: stepIndex is not defined` instead of reporting, and the
  // suite exited after printing one organisation header. The instrumentation
  // added to end three rounds of guessing never ran once.
  //
  // 📌 `node --check` passes on this: the fault is scope, not syntax, and it
  // lives in a branch that only executes when a statement fails. Every suite
  // here is built to be run, and this one was validated by parsing it.
  // `steps` too: the catch reports "step N/total", so it needs the list.
  const steps = Array.isArray(sql) ? sql : [sql];
  let stepIndex = -1;
  let stepText = "";

  await db.query("begin");
  try {
    await db.query("reset role");
    await db.query("set local request.jwt.claims = '{}'");
    const ins = await db.query(
      // ⚠️ Every use of $3 is CAST. Postgres deduces one type per parameter,
      // and this uses it as a payment_status, in a text IN-list and in a
      // boolean comparison — without casts it fails with "inconsistent types
      // deduced for parameter $3", which the first run of this suite reported
      // as nine separate product failures.
      `insert into payments (org_id, vendor_id, amount, status, service_verified_at,
                             performance_validated, invoice_reference ${extra ? ", rejected_reason" : ""})
       values ($1::uuid, $2::uuid, 5000, $3::payment_status,
               case when $3::text in ('verified','recommended') then now() else null end,
               $3::text = 'recommended', 'PROBEAPPEAL'
               ${extra ? ", 'Original refusal reason for the probe'" : ""})
       returning id`,
      [orgId, vendorId, status]
    );
    const id = ins.rows[0].id;
    await db.query("set local role authenticated");
    await db.query(asClaims(actorId));

    // ⚠️ One statement per query. node-pg returns only the LAST result for a
    // multi-statement string, so `rows` silently came back undefined and the
    // reopen assertion crashed on it. `AS SUPERUSER` drops back out of the
    // impersonation mid-scenario — needed to READ a notification addressed to
    // somebody else, which the acting user cannot see and should not be able to.
    let last = { rows: [] };
    // ⚠️ WHICH statement raised, not just what it said.
    //
    // `scenario()` runs a list of statements and reports only the message of
    // whichever one threw. Three rounds were spent on OEA's executive case
    // reading "this payment has 1 earlier stage(s) still to be approved at
    // 5,000.00" and reasoning about which act could have produced it — the
    // fixture, the approve, or the remit — when the answer was one variable
    // away. Each theory was plausible, each cost a run, and none of them was
    // evidence.
    //
    // 📌 The rule this encodes: when a harness hides which of its own steps
    // failed, the next inference is a guess however well argued. The cheap fix
    // is to stop guessing, not to guess better.
    for (const step of steps) {
      stepIndex += 1;
      stepText = String(step).replace(/\s+/g, " ").trim();
      if (step === "AS SUPERUSER") {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
        continue;
      }
      // ⚠️ `CLEAR CHAIN` — since 0151 a payment reaches `approved` only as the
      // outcome of three recorded stages. This suite is about REOPENING a
      // rejected invoice, not about the chain, so satisfying stages 1–2 is a
      // fixture: recorded as superuser, as two people who are not the actor, so
      // separation of duties is met rather than dodged. Everything rolls back
      // with the surrounding transaction.
      if (step === "CLEAR CHAIN") {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
        // ⚠️ The stages are read from `payment_chain_stages(org)`, NOT hardcoded.
        // They used to be the literal triple (facility_manager,
        // payment_audit_approver, payment_approver), which is the TFML ladder —
        // decision 23 gave OEA its own (audit → MP → payment approver), so on
        // that org the fixture pre-recorded a chain the database refuses and
        // every assertion downstream failed for a reason unrelated to what it
        // was testing.
        //
        // `unnest(required_roles)` because a stage may accept several roles;
        // any holder of any of them satisfies the fixture. `distinct on
        // (stage_order)` keeps exactly one actor per stage, and `id <> actorId`
        // keeps separation of duties met rather than dodged.
        await db.query(
          `insert into payment_approvals (org_id, payable_type, payable_id, stage_order,
                                          actor_id, actor_role, actor_tier, amount, decision)
           select distinct on (s.stage_order)
                  $1::uuid, 'vendor_payment', $2::uuid, s.stage_order, u.id,
                  -- ⚠️ THE PAYABLE'S OWN AMOUNT, not a placeholder.
                  --
                  -- This was a literal 1, and 0270's ordering check reads
                  -- amount = the new row's amount: an earlier stage counts as
                  -- approved only if it signed for the sum now in front of the
                  -- desk. A fixture signed for ₦1 satisfies nothing, so the
                  -- first REAL approval landing on a later stage was refused
                  -- with "this payment has 1 earlier stage(s) still to be
                  -- approved at 5,000.00" — the chain working, reported as the
                  -- separation rule failing.
                  --
                  -- 📌 It hid for as long as it did because it is only
                  -- reachable where the acting role lands on a stage that HAS
                  -- an earlier one. Everywhere else stage_order <
                  -- new.stage_order counted nothing and never looked at the
                  -- figure. One ladder, one role, and a placeholder nobody had
                  -- a reason to read.
                  'viewer', null, (select p.amount from payments p where p.id = $2::uuid), 'approved'
             from payment_chain_stages($1::uuid) s
             cross join lateral unnest(s.required_roles) as want
             join users u
               on u.org_id = $1::uuid and u.role = want
              and u.deactivated_at is null and u.id <> $3::uuid
            -- Highest tier first, so the tier-resolved stage is cleared by
            -- someone whose band covers the fixture amount whatever it is.
            order by s.stage_order, u.approval_tier desc nulls last`,
          [orgId, id, actorId]
        );

        // ⚠️ AND THEN CHECK IT WORKED.
        //
        // The insert above can quietly fill FEWER stages than the ladder has,
        // and a short fixture does not look like a short fixture downstream —
        // it looks like the rule under test refusing the act. On OEA it did
        // exactly that: the executive scenario came back "this payment has 1
        // earlier stage(s) still to be approved at 5,000.00", the assertion
        // matched neither spelling of the remit refusal it was looking for, and
        // a MISSING FIXTURE ROW was reported as a failure of separation of
        // duties. The same class of bug the note above records having already
        // fixed once, from the other end: that time the roles were wrong, this
        // time they were right and unheld.
        //
        // It goes short whenever a stage has no holder but the actor —
        // `u.id <> actorId` is separation of duties and is not negotiable, so
        // where an org's cast cannot staff the ladder AROUND this actor, the
        // scenario is unreachable on that org and must say so. Raised with a
        // `FIXTURE:` prefix and reported as a NOTE, never a PASS: a scenario
        // that could not be staged has proved nothing, and must not be able to
        // masquerade as the rule holding.
        const { rows: unfilled } = await db.query(
          `select s.stage_order, array_to_string(s.required_roles, '/') as roles
             from payment_chain_stages($1::uuid) s
            where not exists (
                  select 1 from payment_approvals a
                   where a.payable_type = 'vendor_payment' and a.payable_id = $2::uuid
                     and a.stage_order = s.stage_order)
            order by s.stage_order`,
          [orgId, id]
        );
        if (unfilled.length > 0) {
          throw new Error(
            // Kept short: `scenario()` truncates at 150 characters, and the
            // NAMES of the unstaffed stages are the whole value of this.
            `FIXTURE: stage(s) ${unfilled.map((r) => `${r.stage_order} (${r.roles})`).join(", ")} ` +
            `unheld on this org except by the actor`
          );
        }

        await db.query("set local role authenticated");
        await db.query(asClaims(actorId));
        continue;
      }
      last = await db.query(step.replaceAll("$ID", `'${id}'`));
    }
    await db.query("rollback");
    return { ok: true, rows: last.rows, id };
  } catch (e) {
    await db.query("rollback");
    // A FIXTURE failure is raised by this function about its own setup, so it
    // carries its own explanation and needs no statement attached.
    if (/^FIXTURE:/.test(e.message)) {
      return { ok: false, err: e.message.slice(0, 150) };
    }
    // Postgres's own code, and the statement that drew it. `detail` and `hint`
    // are carried when present: `enforce_approval_rules` puts the reason a
    // stage did not count in one of them, and losing it is what made the same
    // message readable as three different faults.
    const where =
      stepIndex < 0
        ? "fixture setup (before any step ran)"
        : `step ${stepIndex + 1}/${steps.length}: ${stepText.slice(0, 90)}`;
    const extra = [e.code && `[${e.code}]`, e.detail, e.hint].filter(Boolean).join(" ");
    return {
      ok: false,
      err: e.message.slice(0, 150),
      // Kept separate from `err` so every existing assertion that matches on
      // the message keeps matching exactly as it did.
      at: where,
      pg: extra || undefined,
    };
  }
}

const { data: orgs } = await svc.from("orgs")
  .select("id, slug, is_platform_operator").is("deleted_at", null).order("slug");

console.log("Invoice lifecycle — who acts, and what happens when one is refused\n");

for (const org of (orgs ?? []).filter((o) => !o.is_platform_operator)) {
  // ⚠️ Prefer a vendor whose LOGIN IS ACTIVE. `notify_user` declines a
  // deactivated recipient — correctly — so section B against a dormant vendor
  // account reports "nobody was notified" for a product that behaved exactly
  // as designed. The same trap caught verify-role-workflows earlier in this
  // build.
  const { data: allVendors } = await svc.from("vendors")
    .select("id, user_id").eq("org_id", org.id);
  let vendor = null;
  for (const v of allVendors ?? []) {
    if (!v.user_id) continue;
    const { data: vu } = await svc.from("users")
      .select("id").eq("id", v.user_id).is("deactivated_at", null).maybeSingle();
    if (vu) { vendor = v; break; }
  }
  const notifiable = Boolean(vendor);
  if (!vendor) vendor = (allVendors ?? [])[0] ?? null;
  if (!vendor) { note(`${org.slug}: no vendor — skipped`); continue; }

  const who = {};
  // `payment_approver` joins the cast for section C's final-stage check: on the
  // OEA ladder they ARE the final stage, where the executive is only stage 2.
  for (const role of ["facility_manager", "finance_approver", "admin", "executive",
                      "payment_approver", "vendor"]) {
    const { data: u } = await svc.from("users").select("id")
      .eq("org_id", org.id).eq("role", role).is("deactivated_at", null)
      .limit(1).maybeSingle();
    if (u) who[role] = u.id;
  }

  console.log(`── ${org.slug} ──`);

  // ── A. A rejection must say why ─────────────────────────────────────────
  {
    const silent = await scenario(org.id, vendor.id, "pending_verification", who.admin,
      `update payments set status = 'rejected' where id = $ID returning id`);
    !silent.ok && /reason/i.test(silent.err ?? "")
      ? ok("a rejection with no reason is refused — no silent dead ends")
      : bad(`a reasonless rejection was accepted: ${silent.err ?? "allowed"}`);

    const short = await scenario(org.id, vendor.id, "pending_verification", who.admin,
      `select reject_payment($ID, 'too short')`);
    !short.ok
      ? ok("and a token reason is refused too")
      : bad("a 9-character reason was accepted");

    const good = await scenario(org.id, vendor.id, "pending_verification", who.admin,
      `select reject_payment($ID, 'The stairwell lighting is still out - this job is not complete')`);
    good.ok
      ? ok("a rejection WITH a reason is recorded")
      : bad(`could not reject with a reason: ${good.err}`);
  }

  // ── B. The vendor is told ───────────────────────────────────────────────
  {
    const r = await scenario(org.id, vendor.id, "pending_verification", who.admin, [
      `select reject_payment($ID, 'Access was not arranged, so the work could not be checked')`,
      "AS SUPERUSER",
      `select count(*)::int n from user_notifications
        where entity_id = $ID and title like '%was not approved%'`,
    ]);
    // The notification is written inside the same transaction, so it is visible
    // to this SELECT and vanishes on rollback.
    if (!notifiable) {
      note("this org's vendor has no active login — notification not testable here");
    } else {
      r.ok && Number(r.rows?.[0]?.n ?? 0) > 0
        ? ok("and the vendor is notified, with the reason")
        : bad(`no notification reached the vendor: ${r.err ?? "0 rows"}`);
    }
  }

  // ── C. Who may do each step ─────────────────────────────────────────────
  //
  // The answers to "who verifies, who approves, who remits", asserted rather
  // than described.
  {
    if (who.facility_manager) {
      const fmVerify = await scenario(org.id, vendor.id, "pending_verification", who.facility_manager,
        `update payments set status='verified', service_verified_at=now() where id=$ID returning id`);
      // An FM may verify only vendors in their scope; zero rows is a correct
      // refusal for an unscoped vendor, not a failure of the rule.
      fmVerify.ok
        ? ok(`an FM/PM ${fmVerify.rows.length ? "verifies service" : "is scoped out of this vendor (correct)"}`)
        : bad(`FM verification errored: ${fmVerify.err}`);
    }

    if (who.finance_approver) {
      // ⚠️ REWRITTEN FOR THE APPROVAL CHAIN (0151). This asserted that finance
      // approves a recommended invoice. It no longer may — approval is the
      // outcome of three recorded stages, none of which finance can action.
      // The claim is inverted rather than deleted, because "finance cannot
      // approve" is the control decision 16 asked for and is worth holding down
      // here as well as in verify-finance-journey.
      const finApprove = await scenario(org.id, vendor.id, "recommended", who.finance_approver,
        `update payments set status='approved', approved_by='${who.finance_approver}', approved_at=now() where id=$ID returning id`);
      !finApprove.ok && /approval chain/i.test(finApprove.err ?? "")
        ? ok("finance CANNOT approve an invoice — it disburses, it does not authorise")
        : bad(`finance approved without the chain: ${JSON.stringify(finApprove.rows ?? finApprove.err)}`);

      const finRemit = await scenario(org.id, vendor.id, "recommended", who.finance_approver, [
        "CLEAR CHAIN",
        `update payments set status='approved', approved_by='${who.finance_approver}', approved_at=now() where id=$ID`,
        `update payments set status='remitted' where id=$ID returning id`,
      ]);
      finRemit.ok
        ? ok("and finance remits it")
        : /^FIXTURE:/.test(finRemit.err ?? "")
          ? note(`finance remittance not staged here — ${finRemit.err.replace(/^FIXTURE: /, "")}`)
          : bad(
              `finance could not remit: ${finRemit.err}` +
              (finRemit.at ? `\n           raised by ${finRemit.at}` : "") +
              (finRemit.pg ? `\n           ${finRemit.pg}` : "")
            );
    }

    // ⚠️ THE FINAL-STAGE HOLDER, read from this org's own ladder — not the
    // executive, who is only the final stage on three of the four.
    //
    // The rule being asserted is "oversight authorises, the payment officer
    // disburses": whoever gives final approval must still be refused the
    // remittance. This named `executive` outright, and that is the standard
    // ladder's answer only. Decision 23 gave OEA audit → Managing Partner →
    // payment approver (0211), so there the executive is STAGE 2 and final
    // approval belongs to `payment_approver`.
    //
    // 📌 So on OEA the scenario was asking an executive to perform an act that
    // is not theirs, and `enforce_approval_rules` refused it — correctly — with
    // "this payment has 1 earlier stage(s) still to be approved at 5,000.00".
    // The assertion matched neither spelling of the remit refusal it was
    // looking for and reported the chain doing its job as a failure of the
    // separation rule. Four runs and three wrong theories went into that
    // message; what finally settled it was `scenario()` naming the STATEMENT
    // that raised, which was the approve and never the remit.
    //
    // Every role on the final stage that this org actually employs is tested,
    // rather than one of them: the standard ladder's stage 3 admits
    // `payment_approver` AND `executive`, and picking whichever came first in
    // the array would have quietly dropped the executive case from the three
    // orgs where it is the interesting one.
    const { data: stages } = await svc.rpc("payment_chain_stages", { p_org_id: org.id });
    const finalStage = (stages ?? []).reduce(
      (acc, s) => (acc === null || s.stage_order > acc.stage_order ? s : acc), null);
    const finalRoles = (finalStage?.required_roles ?? []).filter((r) => who[r]);

    if (finalRoles.length === 0) {
      note(`no employed role holds this org's final approval stage (${finalStage?.label ?? "?"}) — separation not testable here`);
    }
    for (const role of finalRoles) {
      const actor = who[role];
      // ⚠️ THE OUTCOME IS READ BACK, because "no error" is not "allowed".
      //
      // This asserted the rule held only when the remit RAISED. It reported
      // `payment_approver remittance: ALLOWED` on all four organisations —
      // which sounds like a payment approver can disburse, and does not mean
      // it. 0266 is explicit:
      //
      //     if new.status = 'remitted' then
      //       if caller_role <> 'finance_approver' then raise ...
      //
      // A row-level trigger fires only on rows actually updated, so a
      // statement that matches NOTHING raises nothing. `payments_update` is
      // where that is decided, and a silent zero-row write is indistinguishable
      // from a permitted one if you only look at the error. This suite already
      // knows that — `verify-payment-approver-reach` §D counts rows for exactly
      // this reason, and says so: "PostgREST returned NO error while changing
      // nothing".
      //
      // 📌 So the question asked is the one the rule is actually about: IS THE
      // PAYMENT REMITTED? That is correct whether the write was refused by the
      // trigger, refused by RLS, or permitted — and it cannot be satisfied by
      // an act that quietly did nothing.
      //
      // Read back AS SUPERUSER: the actor may not be able to SELECT the row it
      // just failed to write, and a zero-row read would put us straight back
      // into the ambiguity this exists to remove. Everything still rolls back.
      const remit = await scenario(org.id, vendor.id, "recommended", actor, [
        "CLEAR CHAIN",
        `update payments set status='approved', approved_by='${actor}', approved_at=now() where id=$ID`,
        `update payments set status='remitted' where id=$ID`,
        "AS SUPERUSER",
        `select status::text as status, (approved_at is not null) as approved from payments where id = $ID`,
      ]);
      const outcome = remit.rows?.[0];

      if (/^FIXTURE:/.test(remit.err ?? "")) {
        note(`${role} remittance not staged here — ${remit.err.replace(/^FIXTURE: /, "")}`);
      } else if (!remit.ok) {
        // Decision 23 reworded this and narrowed it to the payment officer
        // alone, where 0151 also allowed an administrator. Both spellings are
        // matched so the check does not depend on which migration a world has
        // reached.
        /may remit payments|only finance or an administrator may remit/i.test(remit.err ?? "")
          ? ok(`a ${role} gives final approval and still cannot remit — refused in the rule's own words`)
          : bad(
              `${role} remittance refused for an unexpected reason: ${remit.err}` +
              (remit.at ? `\n           raised by ${remit.at}` : "") +
              (remit.pg ? `\n           ${remit.pg}` : "")
            );
      } else if (outcome?.status === "remitted") {
        // The only reading that is a defect: money moved on the say-so of the
        // desk that authorised it.
        bad(`!!! a ${role} APPROVED AND REMITTED the same payment — separation of duties is not holding`);
      } else if (outcome?.approved === true) {
        ok(`a ${role} gives final approval and the payment is still ${outcome.status} — the payment officer disburses`);
      } else {
        // NOT a pass. The scenario never reached the state it exists to test,
        // so it has proved nothing about separation of duties — the same trap
        // §D of verify-role-workflows fell into, where filtering a bad fixture
        // turned a false failure into silent zero coverage.
        note(
          `${role} could not be staged here — the payment never reached 'approved' ` +
          `(still ${outcome?.status ?? "unreadable"}), so this role's approval was not exercised. ` +
          `Direct UPDATE on payments is an RLS-gated shortcut; the real path is record_payment_approval.`
        );
      }
    }
  }

  // ── D. The appeal ───────────────────────────────────────────────────────
  {
    // ⚠️ The whole point. Before 0136 `rejected` had no outgoing transition.
    const reopen = await scenario(org.id, vendor.id, "rejected", who.finance_approver ?? who.admin, [
      `select reopen_payment($ID, 'The tenant rating landed after the check ran')`,
      `select status::text, service_verified_at, performance_validated from payments where id = $ID`,
    ], "withReason");
    const row = reopen.ok ? reopen.rows[0] : undefined;
    row?.status === "pending_verification"
      ? ok("a rejected invoice can be REOPENED — the dead end is gone")
      : bad(`could not reopen: ${reopen.err ?? JSON.stringify(row)}`);

    // And it starts the gate again rather than inheriting a verification made
    // before the reason for refusal was known.
    row && row.service_verified_at === null && row.performance_validated === false
      ? ok("and it restarts the gate — verification and performance are cleared")
      : bad(`a reopened invoice kept its gate flags: ${JSON.stringify(row)}`);

    // Reopening corrects a refusal the FM's own performance gate may have
    // produced, so it is not theirs to make.
    if (who.facility_manager) {
      const fmReopen = await scenario(org.id, vendor.id, "rejected", who.facility_manager,
        `select reopen_payment($ID, 'I would like this reconsidered please')`, "withReason");
      // ⚠️ Three outcomes, not two. On this suite's first run the FIXTURE was
      // failing, and "not ok" read as a passing security check — the same trap
      // that made verify-finance-journey shout about a phantom remittance.
      if (fmReopen.ok) {
        bad("!!! an FM reopened a rejection");
      } else if (/could not be found/i.test(fmReopen.err ?? "")) {
        // A stronger refusal than the role check: this FM is not scoped to the
        // vendor, so RLS hid the invoice before the rule was ever reached.
        ok("an FM/PM cannot reopen a rejection — RLS hides an out-of-scope invoice entirely");
      } else if (/may reopen a rejected invoice/i.test(fmReopen.err ?? "")) {
        ok("an FM/PM cannot reopen their own rejection");
      } else {
        bad(`the FM reopen attempt failed for an unrelated reason, proving nothing: ${fmReopen.err}`);
      }
    }

    // A vendor certainly cannot un-reject their own invoice.
    if (who.vendor) {
      const vendorReopen = await scenario(org.id, vendor.id, "rejected", who.vendor,
        `select reopen_payment($ID, 'This job was definitely completed in full')`, "withReason");
      if (vendorReopen.ok) {
        bad("!!! A VENDOR REOPENED THEIR OWN REJECTED INVOICE");
      } else if (/could not be found/i.test(vendorReopen.err ?? "")) {
        // A STRONGER refusal than the role check: RLS hid the row entirely, so
        // the vendor never reached the rule that would have refused them.
        ok("and neither can the vendor — RLS hides the invoice from them entirely");
      } else if (/may reopen a rejected invoice|permission|policy/i.test(vendorReopen.err ?? "")) {
        ok("and neither can the vendor");
      } else {
        bad(`the vendor reopen attempt failed for an unrelated reason: ${vendorReopen.err}`);
      }
    }
  }

  // ── E. Resubmission, which is the ordinary path ─────────────────────────
  {
    // A rejected invoice must not block a corrected one for the same job —
    // otherwise "correct and resubmit" is advice the database refuses.
    const { data: job } = await svc.from("tickets")
      .select("id").eq("org_id", org.id).eq("assigned_vendor_id", vendor.id)
      .in("status", ["resolved", "closed"]).limit(1).maybeSingle();
    if (!job) { note("no finished job for this vendor — resubmission not testable"); }
    else {
      await db.query("begin");
      try {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
        await db.query(
          `insert into payments (org_id, vendor_id, ticket_id, amount, status, invoice_reference, rejected_reason, rejected_at)
           values ($1,$2,$3,5000,'rejected','PROBEAPPEAL-old','Not complete','now')`,
          [org.id, vendor.id, job.id]
        );
        await db.query(
          `insert into payments (org_id, vendor_id, ticket_id, amount, status, invoice_reference)
           values ($1,$2,$3,5000,'pending_verification','PROBEAPPEAL-new')`,
          [org.id, vendor.id, job.id]
        );
        ok("a corrected invoice for the same job is accepted after a rejection");
      } catch (e) {
        bad(`resubmission after rejection was blocked: ${e.message.slice(0, 110)}`);
      }
      await db.query("rollback");
    }
  }

  console.log("");
}

await db.end();

console.log(
  failures === 0
    ? "\x1b[32mALL CHECKS PASSED\x1b[0m — a refusal says why, reaches the vendor, and can be undone by the right person."
    : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
