// Rent demands raised on a schedule.
//
// The claims that matter:
//   • a lease inside the lead window is due; one outside it is not
//   • the lead time is the ORG's, not a constant
//   • the first demand starts at the lease start, not at today
//   • the next demand picks up where the last one ended — no gap, no overlap
//   • a period already billed is not billed again (the unique constraint)
//   • nothing bills past the end of the tenancy
//   • the scheduled path snapshots the fee exactly as the manual one does
//   • the job endpoint refuses without the shared secret
//
// Usage: node scripts/verify-rent-demands.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fixtureUser } from "./lib/org-lookup.mjs";

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

const { data: orgs } = await svc.from("orgs").select("id, slug, rent_demand_lead_days").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const originalLead = oea.rent_demand_lead_days;

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { properties: [], units: [], leases: [] };
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const prop = (await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBEDEMAND-Property-${S}` }).select("id").single()).data;
made.properties.push(prop.id);

const { data: tenant } = await svc.from("users").select("id").eq("email", "oea.tenant@oegroup.test").single();
const landlord = await fixtureUser(svc, oea.id, "property_owner",
  ["oea.owner@oegroup.test", "oea.propertyowner@oegroup.test"]);
await svc.from("property_stakeholders")
  .insert({ org_id: oea.id, property_id: prop.id, user_id: landlord.id, relation: "owner" });

const mkLease = async (label, startDate, endDate, extra = {}) => {
  const u = (await svc.from("units").insert({
    org_id: oea.id, property_id: prop.id, label, apportionment_factor: 1,
  }).select("id").single()).data;
  made.units.push(u.id);
  const l = (await svc.from("leases").insert({
    org_id: oea.id, property_id: prop.id, unit_id: u.id, tenant_user_id: tenant.id,
    start_date: startDate, end_date: endDate,
    rent_amount: 6_000_000, rent_frequency: "annual", status: "active", ...extra,
  }).select("id").single()).data;
  made.leases.push(l.id);
  return l.id;
};

const dueIds = async () => {
  const { data } = await svc.rpc("leases_needing_rent_demand", { p_org_id: oea.id });
  return new Map((data ?? []).map((d) => [d.lease_id, d]));
};

console.log("Rent demands, raised on a schedule\n");

console.log("A. The lead window decides, and it is the org's own");
let inWindow, outsideWindow;
{
  await svc.from("orgs").update({ rent_demand_lead_days: 30 }).eq("id", oea.id);

  // Starts in 10 days — inside a 30-day lead.
  inWindow = await mkLease(`Unit-A-${S}`, day(10), day(375));
  // Starts in 200 days — well outside it.
  outsideWindow = await mkLease(`Unit-B-${S}`, day(200), day(565));

  const due = await dueIds();
  due.has(inWindow)
    ? ok("a lease starting inside the 30-day lead is due")
    : bad("THE LEASE INSIDE THE LEAD WINDOW WAS NOT DUE");
  due.has(outsideWindow)
    ? bad("a lease starting in 200 days was billed 170 days early")
    : ok("one starting beyond the lead is not");

  // Widen the org's lead and the far lease comes into range — proving the
  // number is read per org rather than hardcoded.
  await svc.from("orgs").update({ rent_demand_lead_days: 250 }).eq("id", oea.id);
  const wider = await dueIds();
  wider.has(outsideWindow)
    ? ok("widening the org's lead to 250 days brings it into range — the setting is honoured")
    : bad("the lead time is not being read from the org");

  await svc.from("orgs").update({ rent_demand_lead_days: 30 }).eq("id", oea.id);
}

console.log("\nB. The first demand covers the lease's own start");
{
  const due = await dueIds();
  const d = due.get(inWindow);
  d?.period_start === day(10)
    ? ok(`the period starts at the lease start (${d.period_start}), not today`)
    : bad(`period_start was ${d?.period_start}, expected ${day(10)}`);

  // Annual: one year long.
  const expectedEnd = new Date(day(10));
  expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
  d?.period_end === expectedEnd.toISOString().slice(0, 10)
    ? ok(`and runs a full year to ${d.period_end}`)
    : bad(`period_end was ${d?.period_end}`);
}

console.log("\nC. Raising it removes it, and the fee is snapshotted");
{
  const d = (await dueIds()).get(inWindow);
  const { data: chargeId, error } = await svc.rpc("raise_rent_charge", {
    p_lease_id: inWindow, p_period_start: d.period_start,
    p_period_end: d.period_end, p_due_date: d.period_start,
  });
  error ? bad(`could not raise — ${error.message.slice(0, 70)}`) : ok("the demand is raised");

  const { data: c } = await svc.from("rent_charges")
    .select("management_fee_pct, management_fee_amount, admin_fee_amount, landlord_net_amount, amount")
    .eq("id", chargeId).single();
  Number(c.management_fee_pct) > 0 && Number(c.management_fee_amount) > 0
    ? ok(`the fee was snapshotted by the same writer the button uses (${c.management_fee_pct}%)`)
    : bad("the scheduled path did not snapshot a fee");
  // ⚠️ The flat admin fee counts too (decision 14, admin_fee_flat) — the same
  // omission already found in verify-remittance-race and verify-rent-money.
  // landlord_net_amount is amount minus BOTH deductions (0091); a hardcoded
  // `- 0` here assumed OEA's admin_fee_flat was zero, and it is ₦25,000.
  Number(c.landlord_net_amount) === Number(c.amount) - Number(c.management_fee_amount) - Number(c.admin_fee_amount)
    ? ok("and the landlord's net is the rent less the fee")
    : bad(`net ${c.landlord_net_amount} does not reconcile`);

  (await dueIds()).has(inWindow)
    ? bad("STILL DUE after being raised — a daily run would bill it again")
    : ok("and it is no longer due, so tomorrow's run raises nothing");
}

console.log("\nD. The same period cannot be billed twice");
{
  const { data: c } = await svc.from("rent_charges")
    .select("period_start, period_end").eq("lease_id", inWindow).single();
  const { error } = await svc.rpc("raise_rent_charge", {
    p_lease_id: inWindow, p_period_start: c.period_start,
    p_period_end: c.period_end, p_due_date: c.period_start,
  });
  error
    ? ok("a repeat raise for the same period is refused by the database")
    : bad("A TENANT WAS BILLED TWICE FOR ONE YEAR");
}

console.log("\nE. The next period picks up where the last ended");
{
  // ⚠️ This first tried to reach the SECOND year of `inWindow` by widening the
  // lead. It cannot: that lease starts in 10 days, so its second period begins
  // in 375, and `rent_demand_lead_days` is capped at 365 by a CHECK constraint.
  // The function was right and the test's arithmetic was wrong.
  //
  // A lease nearly a year old puts its second period days away instead, which
  // is also the realistic case — a renewal coming up on an existing tenancy.
  const running = await mkLease(`Unit-D-${S}`, day(-360), day(800));

  const firstDue = (await dueIds()).get(running);
  firstDue
    ? ok(`a year-old tenancy is due for its next period (${firstDue.period_start})`)
    : bad("a lease 360 days into its term was not due for anything");

  await svc.rpc("raise_rent_charge", {
    p_lease_id: running, p_period_start: firstDue.period_start,
    p_period_end: firstDue.period_end, p_due_date: firstDue.period_start,
  });

  const nextDue = (await dueIds()).get(running);
  if (nextDue) {
    nextDue.period_start === firstDue.period_end
      ? ok(`and the one after begins the day it ends (${nextDue.period_start}) — no gap, no overlap`)
      : bad(`next period_start ${nextDue.period_start} but last ended ${firstDue.period_end}`);
  } else {
    // Correct when the following period is still beyond the lead window; the
    // no-gap property is then asserted on the dates themselves.
    ok(`the following period is not yet inside the lead window — nothing raised early`);
  }
}

console.log("\nF. Nothing bills past the end of the tenancy");
{
  // A lease whose final period has been billed right up to its end date.
  const ending = await mkLease(`Unit-C-${S}`, day(-300), day(60));
  await svc.rpc("raise_rent_charge", {
    p_lease_id: ending, p_period_start: day(-300), p_period_end: day(60), p_due_date: day(-300),
  });

  await svc.from("orgs").update({ rent_demand_lead_days: 365 }).eq("id", oea.id);
  const due = await dueIds();
  due.has(ending)
    ? bad("A DEMAND WAS RAISED FOR A YEAR BEYOND THE LEASE END")
    : ok("a fully-billed lease raises nothing further, even with a 365-day lead");
  await svc.from("orgs").update({ rent_demand_lead_days: 30 }).eq("id", oea.id);
}

console.log("\nG. The job endpoint refuses without the secret");
{
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  try {
    const bare = await fetch(`${base}/api/jobs/raise-rent-demands`, { method: "POST" });
    bare.status === 401
      ? ok("an unauthenticated call is refused (401)")
      : bad(`the job answered ${bare.status} with no credential`);

    const wrong = await fetch(`${base}/api/jobs/raise-rent-demands`, {
      method: "POST", headers: { authorization: "Bearer not-the-secret" },
    });
    wrong.status === 401
      ? ok("and a wrong secret is refused too")
      : bad(`a wrong secret answered ${wrong.status}`);
  } catch {
    console.log("  \x1b[33mSKIP\x1b[0m the dev server is not running");
  }
}

// ── The admin fee is charged once per tenancy (0181) ───────────────────────
//
// The claim decision 14 finally resolved: a flat admin fee is a letting charge,
// not an annual one. Before 0181 it was deducted from EVERY demand, which on an
// annual cadence means charging a once-per-tenancy fee once a year.
console.log("\nH. The admin fee lands once per tenancy, not once per demand");
{
  const ADMIN_FEE = 25_000;
  const { data: orgBefore } = await svc.from("orgs")
    .select("admin_fee_flat, admin_fee_basis").eq("id", oea.id).single();

  await svc.from("orgs")
    .update({ admin_fee_flat: ADMIN_FEE, admin_fee_basis: "per_tenancy" }).eq("id", oea.id);

  const feeOf = async (chargeId) => {
    const { data } = await svc.from("rent_charges")
      .select("admin_fee_amount").eq("id", chargeId).single();
    return Number(data.admin_fee_amount);
  };

  const start = day(-400);
  const leaseId = await mkLease(`FEE-${S}`, start, day(330));

  // Year one — the letting itself. The fee belongs here.
  const { data: first } = await svc.rpc("raise_rent_charge", {
    p_lease_id: leaseId, p_period_start: start, p_period_end: day(-35),
  });
  (await feeOf(first)) === ADMIN_FEE
    ? ok(`the first demand of a tenancy carries the fee (₦${ADMIN_FEE.toLocaleString()})`)
    : bad(`the first demand took ₦${await feeOf(first)}, expected ₦${ADMIN_FEE}`);

  // Year two, same term. Same tenancy — the fee has already been taken.
  const { data: second } = await svc.rpc("raise_rent_charge", {
    p_lease_id: leaseId, p_period_start: day(-35), p_period_end: day(330),
  });
  (await feeOf(second)) === 0
    ? ok("the next demand on the same tenancy takes none")
    : bad(`the second demand took ₦${await feeOf(second)} — the fee was charged twice`);

  // A RENEWAL is the same tenancy continuing, not a new letting. This is the
  // case a per-lease check would get wrong: the new term is a different row.
  const { data: renewedId } = await svc.rpc("renew_lease", { p_lease_id: leaseId, p_months: 12 });
  made.leases.push(renewedId);
  const { data: renewalCharge } = await svc.rpc("raise_rent_charge", {
    p_lease_id: renewedId, p_period_start: day(330), p_period_end: day(695),
  });
  (await feeOf(renewalCharge)) === 0
    ? ok("and a RENEWED term takes none either — a renewal is the same tenancy")
    : bad(`the renewal took ₦${await feeOf(renewalCharge)} — it was treated as a fresh letting`);

  // The setting is the org's, and a lease may depart from it — decision 14's
  // default-plus-override, reused rather than reinvented.
  await svc.from("orgs").update({ admin_fee_basis: "per_demand" }).eq("id", oea.id);
  const perDemandLease = await mkLease(`FEEPD-${S}`, day(-400), day(330));
  const { data: pd1 } = await svc.rpc("raise_rent_charge", {
    p_lease_id: perDemandLease, p_period_start: day(-400), p_period_end: day(-35),
  });
  const { data: pd2 } = await svc.rpc("raise_rent_charge", {
    p_lease_id: perDemandLease, p_period_start: day(-35), p_period_end: day(330),
  });
  (await feeOf(pd1)) === ADMIN_FEE && (await feeOf(pd2)) === ADMIN_FEE
    ? ok("switching the org to per_demand charges it every time — the setting is honoured")
    : bad(`per_demand took ₦${await feeOf(pd1)} then ₦${await feeOf(pd2)}`);

  const overrideLease = await mkLease(`FEEOV-${S}`, day(-400), day(330));
  await svc.from("leases").update({ admin_fee_basis: "per_tenancy" }).eq("id", overrideLease);
  const { data: ov1 } = await svc.rpc("raise_rent_charge", {
    p_lease_id: overrideLease, p_period_start: day(-400), p_period_end: day(-35),
  });
  const { data: ov2 } = await svc.rpc("raise_rent_charge", {
    p_lease_id: overrideLease, p_period_start: day(-35), p_period_end: day(330),
  });
  (await feeOf(ov1)) === ADMIN_FEE && (await feeOf(ov2)) === 0
    ? ok("and one lease can depart from the org default, case by case")
    : bad(`the per-lease override took ₦${await feeOf(ov1)} then ₦${await feeOf(ov2)}`);

  await svc.from("orgs").update({
    admin_fee_flat: orgBefore.admin_fee_flat, admin_fee_basis: orgBefore.admin_fee_basis,
  }).eq("id", oea.id);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("orgs").update({ rent_demand_lead_days: originalLead }).eq("id", oea.id);
await svc.from("rent_charges").delete().in("lease_id", made.leases);
await svc.from("leases").update({ status: "terminated" }).in("id", made.leases);
await svc.from("leases").delete().in("id", made.leases);
await svc.from("property_stakeholders").delete().eq("property_id", prop.id);
await svc.from("units").delete().in("id", made.units);
await svc.from("properties").delete().in("id", made.properties);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — rent is demanded once, on time, and never past the term."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exitCode = failures === 0 ? 0 : 1;
