// The approved-application retention clock (0299).
//
// `NDPA_COMPLIANCE_PACK.md` §5's last open row was "approved: tenancy + 6
// years — has no job yet". `0299` closes it by stamping `purge_after`, leaving
// `purge_expired_applications()` (0062) as the only code that deletes anything.
//
// The claims that matter:
//   • an approved application with NO lease has no clock, and is counted so it
//     cannot go unnoticed
//   • a live tenancy is not stamped
//   • an ended tenancy is stamped at end + exactly 6 years
//   • ⚠️ THE RENEWAL TRAP: a first lease that ended years ago but was RENEWED
//     into a still-active one is a LIVE tenancy. `leases.application_id` is not
//     carried forward by a renewal, so the naive query answers with the first
//     lease's end date and would purge a sitting tenant's application. This is
//     the same mistake `0181` found in the admin fee, where it had money on it.
//   • a chain that has fully ended is stamped from the LATEST end in the chain
//   • a stamp is WITHDRAWN if a renewal reopens the tenancy afterwards
//   • a soft-deleted lease neither holds the chain open nor extends it
//   • a rejected application's own 90-day clock (0082) is never touched
//   • the job is idempotent, and deletes nothing
//
// Usage: node scripts/verify-retention-clock.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TAG = "PROBERET";
const S = Date.now().toString(36).toUpperCase().slice(-5);

// ── Sweep debris from an earlier crashed run, before adding more ───────────
//
// Leases first: `properties` and `units` are referenced by them, so a sweep
// that starts at the property fails on the foreign key and leaves everything.
// `leases` is soft-delete only for a signed-in user (`block_hard_delete`,
// 0010) — the service role carries no `auth.uid()`, so this really removes
// them rather than hiding them.
async function sweep() {
  const { data: props } = await svc
    .from("properties").select("id").like("name", `${TAG}%`);
  const propIds = (props ?? []).map((p) => p.id);
  if (propIds.length) {
    await svc.from("leases").delete().in("property_id", propIds);
    const { data: apps } = await svc
      .from("tenant_applications").select("id").in("property_id", propIds);
    const appIds = (apps ?? []).map((a) => a.id);
    if (appIds.length) {
      await svc.from("application_attachments").delete().in("application_id", appIds);
      await svc.from("tenant_applications").delete().in("id", appIds);
    }
    await svc.from("units").delete().in("property_id", propIds);
    await svc.from("properties").delete().in("id", propIds);
  }
  return propIds.length;
}
const swept = await sweep();
if (swept) console.log(`(swept ${swept} propert(y/ies) left by an earlier run)\n`);

console.log("The approved-application retention clock (0299)\n");

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// A client org, never the operator org: `leases_not_on_operator` refuses a
// lease there, and correctly so.
const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, is_platform_operator").is("deleted_at", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }
const org = orgs.find((o) => !o.is_platform_operator);
if (!org) { console.error("no client org on this world to attach fixtures to"); process.exit(1); }

const { data: prop, error: propErr } = await svc
  .from("properties").insert({ org_id: org.id, name: `${TAG}-${S} Court` })
  .select("id").single();
if (propErr) { console.error("could not create probe property:", propErr.message); process.exit(1); }

// One unit per case. `leases_no_overlap` excludes overlapping active/renewed
// ranges on the SAME unit, so sharing one unit across cases would make the
// fixtures refuse each other for reasons that have nothing to do with the
// behaviour under test.
async function unit(label) {
  const { data, error } = await svc
    .from("units").insert({ org_id: org.id, property_id: prop.id, label: `${label}-${S}` })
    .select("id").single();
  if (error) throw new Error(`unit ${label}: ${error.message}`);
  return data.id;
}

async function application(name) {
  const { data, error } = await svc
    .from("tenant_applications").insert({
      org_id: org.id,
      type: "individual",
      status: "approved",
      applicant_name: `${TAG} ${name}`,
      applicant_email: `${TAG.toLowerCase()}.${name.toLowerCase()}.${S}@oegroup.test`,
      property_id: prop.id,
    })
    .select("id, purge_after").single();
  if (error) throw new Error(`application ${name}: ${error.message}`);
  return data;
}

async function lease({ unitId, appId = null, from, to, status, renewedFrom = null, deleted = false }) {
  const { data, error } = await svc
    .from("leases").insert({
      org_id: org.id,
      property_id: prop.id,
      unit_id: unitId,
      application_id: appId,
      start_date: from,
      end_date: to,
      status,
      rent_amount: 1200000,
      renewed_from_lease_id: renewedFrom,
      ...(deleted ? { deleted_at: new Date().toISOString() } : {}),
    })
    .select("id").single();
  if (error) throw new Error(`lease ${status} ${from}..${to}: ${error.message}`);
  return data.id;
}

const y = (n) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};

const endedOn = async (appId) => {
  const { data, error } = await svc.rpc("application_tenancy_ended_on", {
    p_application_id: appId,
  });
  if (error) throw new Error(`application_tenancy_ended_on: ${error.message}`);
  return data;
};

const runJob = async () => {
  const { data, error } = await svc.rpc("stamp_approved_application_retention");
  if (error) throw new Error(`stamp_approved_application_retention: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { stamped: Number(row?.stamped ?? 0), withdrawn: Number(row?.withdrawn ?? 0) };
};

const purgeAfter = async (appId) => {
  const { data, error } = await svc
    .from("tenant_applications").select("purge_after, applicant_name, purged_at")
    .eq("id", appId).single();
  if (error) throw new Error(`read back: ${error.message}`);
  return data;
};

// Six years after `date`, as the date part — what the stamp should equal.
const plusSix = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 6);
  return d.toISOString().slice(0, 10);
};

const made = { apps: [], units: [] };
let exitCode = 0;

try {
  // ── A. No lease: no clock, but counted ──────────────────────────────────
  console.log("A. An approved application that never produced a lease");
  const noLease = await application("NoLease");
  made.apps.push(noLease.id);
  {
    const before = await svc.rpc("approved_applications_without_tenancy");
    (await endedOn(noLease.id)) === null
      ? ok("has no tenancy end date — the clock cannot start")
      : bad("claims a tenancy ended when no lease exists");
    Number(before.data ?? 0) >= 1
      ? ok(`counted by approved_applications_without_tenancy (${before.data}) — visible, not silent`)
      : bad("not counted — an approved application with no clock would go unnoticed");
  }

  // ── B. A live tenancy is not stamped ────────────────────────────────────
  console.log("\nB. A tenancy still running");
  const live = await application("Live");
  made.apps.push(live.id);
  {
    const u = await unit("B"); made.units.push(u);
    await lease({ unitId: u, appId: live.id, from: y(1), to: y(-1), status: "active" });
    (await endedOn(live.id)) === null
      ? ok("no end date while the lease is active")
      : bad("a live tenancy reports an end date");
    await runJob();
    (await purgeAfter(live.id)).purge_after === null
      ? ok("the job leaves it unstamped")
      : bad("a sitting tenant's application was given a purge date");
  }

  // ── C. A single ended tenancy is stamped at end + 6 years ───────────────
  console.log("\nC. A tenancy that ended");
  const ended = await application("Ended");
  made.apps.push(ended.id);
  const endedDate = y(7);
  {
    const u = await unit("C"); made.units.push(u);
    await lease({ unitId: u, appId: ended.id, from: y(8), to: endedDate, status: "expired" });
    (await endedOn(ended.id)) === endedDate
      ? ok(`end date is the lease's own (${endedDate})`)
      : bad(`end date was ${await endedOn(ended.id)}, expected ${endedDate}`);
    await runJob();
    const got = (await purgeAfter(ended.id)).purge_after;
    got && got.slice(0, 10) === plusSix(endedDate)
      ? ok(`stamped ${got.slice(0, 10)} — exactly six years after the tenancy ended`)
      : bad(`stamped ${got}, expected ${plusSix(endedDate)}`);
  }

  // ── D. THE RENEWAL TRAP ─────────────────────────────────────────────────
  console.log("\nD. ⚠️  The renewal trap — first lease ended, renewal still running");
  const renewed = await application("Renewed");
  made.apps.push(renewed.id);
  {
    const u = await unit("D"); made.units.push(u);
    // The lease the application produced ended seven years ago...
    const first = await lease({
      unitId: u, appId: renewed.id, from: y(8), to: y(7), status: "renewed",
    });
    // ...and was renewed into one that is still running. Note it carries NO
    // application_id — that is precisely why the naive query gets this wrong.
    await lease({
      unitId: u, from: y(7), to: y(-1), status: "active", renewedFrom: first,
    });

    // What the naive query would have said, measured rather than asserted.
    const { data: naive } = await svc
      .from("leases").select("end_date").eq("application_id", renewed.id);
    const naiveAnswer = (naive ?? []).map((l) => l.end_date).sort().pop();

    (await endedOn(renewed.id)) === null
      ? ok(`the tenancy is live — the chain is followed past the renewal (naive query would have said ${naiveAnswer})`)
      : bad(`reported an end date for a tenancy still running under a renewal — this is the ${naiveAnswer} bug`);

    await runJob();
    (await purgeAfter(renewed.id)).purge_after === null
      ? ok("the sitting tenant's application is NOT stamped")
      : bad("a sitting tenant's application was stamped for purge — the exact failure this function exists to prevent");
  }

  // ── E. A chain that has fully ended uses the LATEST end ─────────────────
  console.log("\nE. A renewal chain that has fully ended");
  const chainEnded = await application("ChainEnded");
  made.apps.push(chainEnded.id);
  const lastEnd = y(7);
  {
    const u = await unit("E"); made.units.push(u);
    const first = await lease({
      unitId: u, appId: chainEnded.id, from: y(9), to: y(8), status: "renewed",
    });
    await lease({
      unitId: u, from: y(8), to: lastEnd, status: "expired", renewedFrom: first,
    });
    (await endedOn(chainEnded.id)) === lastEnd
      ? ok(`end date is the LAST lease in the chain (${lastEnd}), not the first`)
      : bad(`end date was ${await endedOn(chainEnded.id)}, expected the chain's last end ${lastEnd}`);
    await runJob();
    const got = (await purgeAfter(chainEnded.id)).purge_after;
    got && got.slice(0, 10) === plusSix(lastEnd)
      ? ok(`stamped ${got.slice(0, 10)} — six years after the LAST tenancy ended`)
      : bad(`stamped ${got}, expected ${plusSix(lastEnd)}`);
  }

  // ── F. A stamp is withdrawn when a renewal reopens the tenancy ──────────
  console.log("\nF. A renewal recorded AFTER the clock started");
  {
    const u = await unit("F"); made.units.push(u);
    const reopened = await application("Reopened");
    made.apps.push(reopened.id);
    const first = await lease({
      unitId: u, appId: reopened.id, from: y(9), to: y(8), status: "expired",
    });
    await runJob();
    (await purgeAfter(reopened.id)).purge_after !== null
      ? ok("stamped while the tenancy looked finished")
      : bad("not stamped when it should have been");

    // The tenant comes back: a renewal is recorded against the old lease.
    await svc.from("leases").update({ status: "renewed" }).eq("id", first);
    await lease({ unitId: u, from: y(8), to: y(-1), status: "active", renewedFrom: first });

    const run = await runJob();
    const after = await purgeAfter(reopened.id);
    after.purge_after === null
      ? ok(`the stamp is withdrawn — the clock stops (withdrawn: ${run.withdrawn})`)
      : bad(`purge date survived a reopened tenancy: ${after.purge_after}`);
  }

  // ── G. A soft-deleted lease counts for nothing ──────────────────────────
  console.log("\nG. A retracted (soft-deleted) lease");
  {
    const u = await unit("G"); made.units.push(u);
    const retracted = await application("Retracted");
    made.apps.push(retracted.id);
    await lease({ unitId: u, appId: retracted.id, from: y(8), to: y(7), status: "expired" });
    // A later lease that was retracted: it must neither extend the end date...
    await lease({
      unitId: u, appId: retracted.id, from: y(3), to: y(2), status: "expired", deleted: true,
    });
    (await endedOn(retracted.id)) === y(7)
      ? ok("a retracted lease does not push the end date out")
      : bad(`a retracted lease changed the end date to ${await endedOn(retracted.id)}`);

    // ...nor hold the chain open.
    const u2 = await unit("G2"); made.units.push(u2);
    const held = await application("HeldOpen");
    made.apps.push(held.id);
    await lease({ unitId: u2, appId: held.id, from: y(8), to: y(7), status: "expired" });
    await lease({
      unitId: u2, appId: held.id, from: y(1), to: y(-1), status: "active", deleted: true,
    });
    (await endedOn(held.id)) === y(7)
      ? ok("a retracted ACTIVE lease does not hold the tenancy open")
      : bad("a retracted active lease kept the clock from starting");
  }

  // ── H. A rejection's own 90-day clock is untouched ──────────────────────
  console.log("\nH. The 90-day rejection clock (0082) is not this job's business");
  {
    const { data: rej, error } = await svc
      .from("tenant_applications").insert({
        org_id: org.id, type: "individual", status: "rejected",
        applicant_name: `${TAG} Rejected`,
        applicant_email: `${TAG.toLowerCase()}.rejected.${S}@oegroup.test`,
        property_id: prop.id,
        purge_after: new Date(Date.now() + 90 * 864e5).toISOString(),
      })
      .select("id, purge_after").single();
    if (error) throw new Error(`rejected fixture: ${error.message}`);
    made.apps.push(rej.id);
    await runJob();
    const after = await purgeAfter(rej.id);
    after.purge_after === rej.purge_after
      ? ok("a rejected application's 90-day date is left exactly as it was")
      : bad(`the job moved a rejection's purge date: ${rej.purge_after} → ${after.purge_after}`);
  }

  // ── I. Idempotent, and it deletes nothing ───────────────────────────────
  console.log("\nI. Running it twice, and what it does NOT do");
  {
    const second = await runJob();
    second.stamped === 0 && second.withdrawn === 0
      ? ok("a second run changes nothing — stamped 0, withdrawn 0")
      : bad(`a second run was not a no-op: stamped ${second.stamped}, withdrawn ${second.withdrawn}`);

    const still = await purgeAfter(ended.id);
    still.applicant_name === `${TAG} Ended` && still.purged_at === null
      ? ok("the stamped application still holds its PII and is not purged — this job deletes nothing")
      : bad("the stamping job removed data; only purge_expired_applications() may do that");
  }

  // The deletion path is the one that already existed, and this migration must
  // not have grown a second one. Asserted against the source, because the
  // behavioural test for it is six years away.
  console.log("\nJ. One deletion path, not two");
  {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(path.join(rootDir, "supabase/migrations/0299_the_six_year_clock_starts_when_the_tenancy_ends.sql"), "utf8")
    );
    const body = src.replace(/^\s*--.*$/gm, "");
    /\bdelete\s+from\b/i.test(body)
      ? bad("0299 contains a DELETE — the 6-year rule must reuse purge_expired_applications(), not add a second deletion path")
      : ok("0299 contains no DELETE of its own");
    /purge_after/.test(body)
      ? ok("it works by setting purge_after, which the proven purge already acts on")
      : bad("it does not set purge_after, so the existing purge will never act on it");
  }
} catch (err) {
  failures++;
  console.log(`\n  \x1b[31mFAIL\x1b[0m threw: ${err.message}`);
} finally {
  // ── Cleanup ─────────────────────────────────────────────────────────────
  const { data: leases } = await svc
    .from("leases").select("id").eq("property_id", prop.id);
  if (leases?.length) {
    const { error } = await svc.from("leases").delete().eq("property_id", prop.id);
    if (error) console.warn(`  (cleanup: ${leases.length} probe lease(s) could not be removed — ${error.message})`);
  }
  if (made.apps.length) {
    await svc.from("application_attachments").delete().in("application_id", made.apps);
    const { error } = await svc.from("tenant_applications").delete().in("id", made.apps);
    if (error) console.warn(`  (cleanup: probe applications could not be removed — ${error.message})`);
  }
  if (made.units.length) {
    const { error } = await svc.from("units").delete().in("id", made.units);
    if (error) console.warn(`  (cleanup: probe units could not be removed — ${error.message})`);
  }
  {
    const { error } = await svc.from("properties").delete().eq("id", prop.id);
    if (error) console.warn(`  (cleanup: probe property could not be removed — ${error.message})`);
  }
  exitCode = failures === 0 ? 0 : 1;
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll retention-clock checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(exitCode);
