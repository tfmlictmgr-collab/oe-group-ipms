// A request nobody picks up reaches the administrator — decision 23.
//
// Board direction, 28 Aug 2026: the administrator *"assigns job requests
// flagged as unassigned after 24 hours of a vendor/tenant/landlord/fm/pm/
// regional job request raise."*
//
// ⚠️ WHAT THIS SUITE IS GUARDING. 0178 stopped an administrator being the
// person who both RECEIVES a request and DISPATCHES it with nobody operational
// in between — the intake-path twin of decision 16 — and put the escape hatch
// behind `tickets.assign_without_review`, off by default for every role
// including admin. The rescue added by 0212 is an EXCEPTION to that control, so
// the thing worth proving is not that it works but that it is NARROW:
//
//   • it does not apply before 24 hours (section 2);
//   • it does not apply to anyone but an administrator (section 3);
//   • it does not apply to a request somebody has already looked at;
//   • and when it does apply, the administrator is recorded as the reviewer
//     rather than the dispatch being anonymous (section 4).
//
// Every refusal is verified by ATTEMPTING the operation as a real signed-in
// user, never by reading a policy.
//
// Usage: node scripts/verify-unassigned-escalation.mjs
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local", quiet: true });

if (!process.env.SUPABASE_DB_HOST) {
  console.error("Missing SUPABASE_DB_* in .env.local");
  process.exit(2);
}
if (/prod/i.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: target looks like production. This writes fixture rows.");
  process.exit(2);
}

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

/** Run as `uid`, rolling back afterwards so no fixture state survives. */
async function asUser(uid, fn) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`
    );
    return await fn();
  } catch (e) {
    return { error: e };
  } finally {
    await client.query("rollback");
  }
}

await client.connect();
try {
  const { rows: orgs } = await client.query(
    `select id, name from orgs where deleted_at is null and not is_platform_operator order by name limit 1`
  );
  const org = orgs[0];
  if (!org) { console.error("no org to test against"); process.exit(2); }

  const pick = async (role) => {
    const { rows } = await client.query(
      `select id from users where org_id = $1 and role = $2 and deactivated_at is null limit 1`,
      [org.id, role]
    );
    return rows[0]?.id ?? null;
  };

  const admin = await pick("admin");
  const fm = (await pick("facility_manager")) ?? (await pick("property_manager"));
  const vendorRow = await client.query(
    `select id from vendors where org_id = $1 limit 1`, [org.id]
  );
  const vendorId = vendorRow.rows[0]?.id ?? null;

  if (!admin || !vendorId) {
    console.error("need an administrator and a vendor on this org");
    process.exit(2);
  }

  console.log(`\nUnassigned-request escalation (decision 23) — org "${org.name}"\n`);

  /**
   * Create a ticket aged `hours` old, unassigned and unreviewed. Written by the
   * SERVICE ROLE (owner), which is how a real inbound request arrives — the
   * point of the suite is what happens NEXT, as a signed-in person.
   */
  const mkTicket = async (hours) => {
    const { rows } = await client.query(
      `insert into tickets (org_id, channel, message_text, category, urgency, status, created_at)
       values ($1, 'portal', 'Probe escalation fixture', 'maintenance', 'normal', 'open',
               now() - ($2 || ' hours')::interval)
       returning id`,
      [org.id, String(hours)]
    );
    return rows[0].id;
  };

  const made = [];
  /**
   * Attempt a dispatch as `uid`.
   *
   * ⚠️ `ok` means the row ACTUALLY MOVED, not merely that no error was raised.
   * An UPDATE a policy declines to match affects zero rows and raises nothing —
   * so an earlier version of this suite read "no error" as "dispatched" and
   * reported four roles as having defeated the control when in fact
   * `tickets_update` had silently refused every one of them. A test that cannot
   * tell a refusal from a no-op is worse than no test: it fails loudly for the
   * wrong reason and would pass quietly for the wrong reason too.
   */
  const attemptDispatch = async (uid, ticketId) =>
    asUser(uid, async () => {
      try {
        const { rowCount } = await client.query(
          `update tickets set assigned_vendor_id = $1 where id = $2`,
          [vendorId, ticketId]
        );
        if (rowCount === 0) {
          return { ok: false, error: "no rows updated (the policy declined to match)" };
        }
        // Read back INSIDE the transaction — the rollback discards it either way.
        const { rows } = await client.query(
          `select assigned_vendor_id, reviewed_by, reviewed_at from tickets where id = $1`,
          [ticketId]
        );
        return { ok: rows[0]?.assigned_vendor_id === vendorId, row: rows[0] };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

  // -------------------------------------------------------------------------
  console.log("1. The rescue works once the request has actually been sitting");
  // -------------------------------------------------------------------------
  {
    const t = await mkTicket(30);
    made.push(t);
    const r = await attemptDispatch(admin, t);
    if (r.ok) {
      ok("an administrator dispatches a request unassigned for 30 hours");
      r.row?.reviewed_by === admin
        ? ok("and is recorded as the reviewer — the rescue is not anonymous")
        : bad(`the dispatch was not attributed — reviewed_by = ${r.row?.reviewed_by}`);
      r.row?.reviewed_at
        ? ok("with the moment it happened")
        : bad("reviewed_at was not stamped");
    } else {
      bad(`the administrator was refused after 30 hours — ${r.error}`);
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n2. It does NOT apply before the 24 hours are up");
  // -------------------------------------------------------------------------
  {
    // 23 hours: the request is stale-ish and the rescue must still refuse. An
    // off-by-one here is the difference between a safety valve and 0178 being
    // switched off for administrators.
    const t = await mkTicket(23);
    made.push(t);
    const r = await attemptDispatch(admin, t);
    !r.ok && /has not been reviewed/i.test(r.error ?? "")
      ? ok("at 23 hours the administrator is still refused (0178 holds)")
      : bad("AN ADMINISTRATOR DISPATCHED A REQUEST LESS THAN 24 HOURS OLD");

    const t2 = await mkTicket(1);
    made.push(t2);
    const r2 = await attemptDispatch(admin, t2);
    !r2.ok && /has not been reviewed/i.test(r2.error ?? "")
      ? ok("and at 1 hour")
      : bad("AN ADMINISTRATOR DISPATCHED A ONE-HOUR-OLD REQUEST");
  }

  // -------------------------------------------------------------------------
  console.log("\n3. It is the administrator's alone");
  // -------------------------------------------------------------------------
  {
    // ⚠️ An FM reaching this branch would be harmless (they are who the review
    // is FOR). The roles that matter are the ones 0178 was written about, and
    // the ones decision 23 has just removed from the money chain — neither
    // acquires an intake power as a side effect.
    for (const role of ["finance_approver", "payment_approver", "payment_audit_approver", "executive"]) {
      const uid = await pick(role);
      if (!uid) continue;
      const t = await mkTicket(72);
      made.push(t);
      const r = await attemptDispatch(uid, t);
      r.ok
        ? bad(`A ${role.toUpperCase()} DISPATCHED A STALE REQUEST — the rescue is not admin-only`)
        : ok(`${role} cannot use the 24-hour rescue (${(r.error ?? "").slice(0, 44)})`);
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n4. A request somebody has already reviewed is not 'unassigned'");
  // -------------------------------------------------------------------------
  {
    if (fm) {
      const t = await mkTicket(72);
      made.push(t);
      // Reviewed long ago but never dispatched. The rescue's condition is
      // `old.reviewed_at is null`, so this should take the ORDINARY path — which
      // succeeds, because a reviewed request may be dispatched by anyone who may
      // assign. The check is that it is NOT recorded as an escalation.
      await client.query(
        `update tickets set reviewed_at = now() - interval '70 hours', reviewed_by = $1 where id = $2`,
        [fm, t]
      );
      const r = await attemptDispatch(admin, t);
      r.ok && r.row?.reviewed_by === fm
        ? ok("an already-reviewed request keeps the FM as its reviewer, not the administrator")
        : bad(`the rescue overwrote an existing review — reviewed_by = ${r.row?.reviewed_by}`);
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n5. The queue and the notification");
  // -------------------------------------------------------------------------
  {
    const { rows: stale } = await client.query(
      `select count(*)::int as n from stale_unassigned_requests() where org_id = $1`,
      [org.id]
    );
    stale[0].n >= 3
      ? ok(`stale_unassigned_requests() lists the ${stale[0].n} waiting request(s)`)
      : bad(`the rescue queue shows ${stale[0].n} — the fixtures above should be in it`);

    // ⚠️ Fires once per request, and `escalated_at` is what makes that true.
    // A retrying job must not tell an administrator the same thing three times
    // (decision 15's rule, applied here).
    //
    // 📌 Run inside a transaction that is ROLLED BACK. The job is org-wide by
    // design and would otherwise stamp `escalated_at` on every genuinely stale
    // request in the world this suite is pointed at, and send their
    // administrators real notifications — a verification script must not spend
    // somebody's one-time notification to prove it is one-time.
    await client.query("begin");
    try {
      const first = await client.query(`select escalate_stale_unassigned_requests() as n`);
      const second = await client.query(`select escalate_stale_unassigned_requests() as n`);
      first.rows[0].n > 0
        ? ok(`the job flagged ${first.rows[0].n} request(s) to the administrators`)
        : bad("the job flagged nothing despite a non-empty queue");
      Number(second.rows[0].n) === 0
        ? ok("and a second run flags none of them again — the record decides, not the schedule")
        : bad(`a re-run flagged ${second.rows[0].n} again — administrators get told twice`);
    } finally {
      await client.query("rollback");
    }
  }

  // Teardown. The fixtures are real tickets in a real org, so they go.
  //
  // `audit_log` is deliberately NOT swept: it is append-only and refuses DELETE
  // to everyone, which is the guarantee that makes it evidence. Whatever these
  // fixtures wrote there stays, as it should.
  for (const id of made) {
    await client.query(`delete from user_notifications where entity_id = $1`, [id]);
    await client.query(`delete from tickets where id = $1`, [id]);
  }
  console.log(`\ncleanup: ${made.length} probe request(s) removed`);
} finally {
  await client.end();
}

console.log(failures === 0
  ? "\n\x1b[32mAll unassigned-escalation checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
