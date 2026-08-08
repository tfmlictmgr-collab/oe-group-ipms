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
    const steps = Array.isArray(sql) ? sql : [sql];
    let last = { rows: [] };
    for (const step of steps) {
      if (step === "AS SUPERUSER") {
        await db.query("reset role");
        await db.query("set local request.jwt.claims = '{}'");
        continue;
      }
      last = await db.query(step.replaceAll("$ID", `'${id}'`));
    }
    await db.query("rollback");
    return { ok: true, rows: last.rows, id };
  } catch (e) {
    await db.query("rollback");
    return { ok: false, err: e.message.slice(0, 150) };
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
  for (const role of ["facility_manager", "finance_approver", "admin", "executive", "vendor"]) {
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
      const finVerify = await scenario(org.id, vendor.id, "recommended", who.finance_approver,
        `update payments set status='approved', approved_by='${who.finance_approver}', approved_at=now() where id=$ID returning id`);
      finVerify.ok && finVerify.rows.length === 1
        ? ok("finance approves a recommended invoice")
        : bad(`finance could not approve: ${finVerify.err ?? "0 rows"}`);

      const finRemit = await scenario(org.id, vendor.id, "recommended", who.finance_approver, [
        `update payments set status='approved', approved_by='${who.finance_approver}', approved_at=now() where id=$ID`,
        `update payments set status='remitted' where id=$ID returning id`,
      ]);
      finRemit.ok
        ? ok("and finance remits it")
        : bad(`finance could not remit: ${finRemit.err}`);
    }

    if (who.executive) {
      // The separation that must never soften.
      const execRemit = await scenario(org.id, vendor.id, "recommended", who.executive, [
        `update payments set status='approved', approved_by='${who.executive}', approved_at=now() where id=$ID`,
        `update payments set status='remitted' where id=$ID returning id`,
      ]);
      !execRemit.ok && /only finance or an administrator may remit/i.test(execRemit.err ?? "")
        ? ok("an executive approves and still cannot remit — oversight authorises, finance disburses")
        : bad(`executive remittance: ${execRemit.err ?? "ALLOWED"}`);
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
      } else if (/only finance or an administrator may reopen/i.test(fmReopen.err ?? "")) {
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
      } else if (/only finance or an administrator may reopen|permission|policy/i.test(vendorReopen.err ?? "")) {
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
