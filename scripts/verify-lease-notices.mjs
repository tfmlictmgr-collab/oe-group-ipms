// Renewal notices, sent once each.
//
// The claims that matter:
//   • a lease at a configured threshold is due
//   • once recorded, it is NOT due again — the history decides, not the schedule
//   • each threshold is its own notice, so a tenancy is told at 90, 60 and 30
//   • the record cannot be written by a signed-in user
//   • the job endpoint refuses without the shared secret
//
// Usage: node scripts/verify-lease-notices.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

const { data: orgs } = await svc.from("orgs").select("id, slug, renewal_notice_days").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { properties: [], units: [], leases: [] };

const prop = (await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBENOTICE-Property-${S}` }).select("id").single()).data;
made.properties.push(prop.id);
const unit = (await svc.from("units")
  .insert({ org_id: oea.id, property_id: prop.id, label: `Unit ${S}`, apportionment_factor: 1 })
  .select("id").single()).data;
made.units.push(unit.id);
const { data: tenant } = await svc.from("users").select("id").eq("email", "oea.tenant@oegroup.test").single();

const dateIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const lease = (await svc.from("leases").insert({
  org_id: oea.id, property_id: prop.id, unit_id: unit.id, tenant_user_id: tenant.id,
  start_date: "2026-01-01", end_date: dateIn(90),
  rent_amount: 4_000_000, escalation_pct: 10, status: "active",
}).select("id").single()).data;
made.leases.push(lease.id);

console.log("Renewal notices, once each\n");

console.log("A. A lease at a threshold is due, once");
{
  const { data: due } = await svc.rpc("leases_needing_notice", { p_org_id: oea.id });
  const mine = (due ?? []).filter((d) => d.lease_id === lease.id);
  mine.length === 1
    ? ok(`the lease is due at 90 days (proposed rent ₦${Number(mine[0].proposed_rent).toLocaleString()})`)
    : bad(`expected 1 due row, got ${mine.length}`);

  // Record the notice, as the job does.
  const { error } = await svc.from("lease_notices").insert({
    org_id: oea.id, lease_id: lease.id, threshold_days: 90,
    recipient: "probe@oegroup-probe.test", channel: "email",
  });
  error ? bad(`could not record the notice — ${error.message.slice(0, 70)}`) : ok("the notice is recorded");

  const { data: after } = await svc.rpc("leases_needing_notice", { p_org_id: oea.id });
  (after ?? []).some((d) => d.lease_id === lease.id)
    ? bad("THE LEASE IS STILL DUE — a job that retries would notify twice")
    : ok("and it is no longer due, so a retry sends nothing");

  // The unique key is the guarantee, not the query.
  const { error: dup } = await svc.from("lease_notices").insert({
    org_id: oea.id, lease_id: lease.id, threshold_days: 90,
  });
  dup ? ok("a duplicate at the same threshold is refused by the database")
      : bad("A SECOND NOTICE WAS RECORDED AT THE SAME THRESHOLD");
}

console.log("\nB. Each threshold is its own notice");
{
  await svc.from("leases").update({ end_date: dateIn(60) }).eq("id", lease.id);
  const { data: due } = await svc.rpc("leases_needing_notice", { p_org_id: oea.id });
  (due ?? []).some((d) => d.lease_id === lease.id)
    ? ok("at 60 days the same tenancy is due again — a different notice, not a repeat")
    : bad("THE 60-DAY NOTICE DID NOT FIRE after the 90-day one was sent");

  await svc.from("lease_notices").insert({
    org_id: oea.id, lease_id: lease.id, threshold_days: 60,
  });
  const { data: after } = await svc.rpc("leases_needing_notice", { p_org_id: oea.id });
  (after ?? []).some((d) => d.lease_id === lease.id)
    ? bad("still due at 60 after being recorded")
    : ok("and once told, it settles again");

  // A day that is not a threshold produces nothing.
  await svc.from("leases").update({ end_date: dateIn(45) }).eq("id", lease.id);
  const { data: off } = await svc.rpc("leases_needing_notice", { p_org_id: oea.id });
  (off ?? []).some((d) => d.lease_id === lease.id)
    ? bad("A NOTICE FIRED AT 45 DAYS, which is not a configured threshold")
    : ok("45 days is not a threshold, so nothing fires");
}

console.log("\nC. The record cannot be written by a signed-in user");
{
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: authErr } = await c.auth.signInWithPassword({
    email: "oea.admin@oegroup.test", password: PW,
  });
  if (authErr) bad("could not sign in as the OEA administrator");
  else {
    const { error } = await c.from("lease_notices").insert({
      org_id: oea.id, lease_id: lease.id, threshold_days: 30,
    });
    error
      ? ok("an administrator cannot mark a notice sent")
      : bad("A NOTICE WAS MARKED SENT BY HAND — the tenancy could run out with everyone believing the tenant was told");

    const { data: readable } = await c.from("lease_notices").select("id").eq("lease_id", lease.id);
    (readable ?? []).length >= 2
      ? ok("but they can read what was sent")
      : bad(`an administrator saw ${(readable ?? []).length} notices on their own org's lease`);
    await c.auth.signOut();
  }
}

console.log("\nD. The job endpoint refuses without the secret");
{
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/jobs/lease-notices`, { method: "POST" });
    res.status === 401
      ? ok("an unauthenticated call is refused (401)")
      : bad(`the job answered ${res.status} with no credential`);

    const wrong = await fetch(`${base}/api/jobs/lease-notices`, {
      method: "POST", headers: { authorization: "Bearer definitely-not-the-secret" },
    });
    wrong.status === 401
      ? ok("and a wrong secret is refused too")
      : bad(`a wrong secret answered ${wrong.status}`);
  } catch {
    console.log("  \x1b[33mSKIP\x1b[0m the dev server is not running");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("lease_notices").delete().in("lease_id", made.leases);
await svc.from("leases").update({ status: "terminated" }).in("id", made.leases);
await svc.from("leases").delete().in("id", made.leases);
await svc.from("units").delete().in("id", made.units);
await svc.from("properties").delete().in("id", made.properties);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a tenant is told once per threshold, whatever the scheduler does."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
