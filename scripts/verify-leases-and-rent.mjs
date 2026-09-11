// Leases, rent billing, and the fee model behind a landlord statement.
//
// The claims that matter:
//   • a unit cannot be let twice over the same days
//   • the fee rate is SNAPSHOTTED, so changing it later does not rewrite a past
//     statement — decision 14's whole point
//   • a landlord's negotiated rate overrides the org default, and resetting it
//     falls back rather than zeroing
//   • rent_charges cannot be written by hand, only through raise_rent_charge
//   • the same period cannot be billed twice
//   • renewal applies the escalation to the NEW term and never the old
//   • a tenant sees their own lease and nobody else's
//   • notices fire once per threshold, not every day until expiry
//
// Usage: node scripts/verify-leases-and-rent.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fixtureUser } from "./lib/org-lookup.mjs";

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
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  return error ? null : c;
};

const { data: orgs } = await svc.from("orgs").select("id, slug, management_fee_pct").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = { properties: [], units: [], leases: [], terms: [] };

// ── Fixtures ──────────────────────────────────────────────────────────────
const prop = (await svc.from("properties")
  .insert({ org_id: oea.id, name: `PROBELEASE-Property-${S}` })
  .select("id").single()).data;
made.properties.push(prop.id);

const unit = (await svc.from("units")
  .insert({ org_id: oea.id, property_id: prop.id, label: `Flat ${S}`, apportionment_factor: 1 })
  .select("id").single()).data;
made.units.push(unit.id);

const { data: tenant } = await svc.from("users")
  .select("id").eq("email", "oea.tenant@oegroup.test").single();
const landlord = await fixtureUser(svc, oea.id, "property_owner",
  ["oea.owner@oegroup.test", "oea.propertyowner@oegroup.test"]);

// The landlord owns this property, which is how the fee resolves.
await svc.from("property_stakeholders").insert({
  org_id: oea.id, property_id: prop.id, user_id: landlord.id, relation: "owner",
});

const mkLease = async (extra = {}) => {
  const { data, error } = await svc.from("leases").insert({
    org_id: oea.id, property_id: prop.id, unit_id: unit.id,
    tenant_user_id: tenant.id,
    start_date: "2026-09-01", end_date: "2027-09-01",
    rent_amount: 5_000_000, rent_frequency: "annual",
    escalation_pct: 10, status: "active", ...extra,
  }).select("id, rent_amount, status, start_date, end_date").single();
  if (data) made.leases.push(data.id);
  return { data, error };
};

console.log("Leases, rent, and the landlord's share\n");

console.log("A. A unit cannot be let twice over the same days");
let lease;
{
  const a = await mkLease();
  a.data ? ok("the first tenancy is recorded") : bad(`could not create a lease — ${a.error?.message.slice(0, 70)}`);
  lease = a.data;

  const overlap = await mkLease({ start_date: "2027-01-01", end_date: "2028-01-01" });
  overlap.error
    ? ok("an overlapping tenancy on the same unit is refused by the database")
    : bad("A UNIT WAS LET TWICE OVER THE SAME DAYS");

  // Back-to-back must still be allowed, or no unit could ever be re-let.
  const after = await mkLease({ start_date: "2027-09-01", end_date: "2028-09-01" });
  after.data
    ? ok("but a term starting the day the last one ends is allowed")
    : bad(`BACK-TO-BACK TERMS WERE REFUSED — ${after.error?.message.slice(0, 60)}`);
  if (after.data) await svc.from("leases").update({ status: "terminated" }).eq("id", after.data.id);
}

console.log("\nB. The fee is snapshotted, not referenced live");
let charge;
{
  const { data: id, error } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2026-09-01", p_period_end: "2027-09-01",
  });
  if (error) bad(`could not raise rent — ${error.message.slice(0, 70)}`);
  const { data: c } = await svc.from("rent_charges").select("*").eq("id", id).single();
  charge = c;

  c?.management_fee_pct == oea.management_fee_pct
    ? ok(`the charge froze the org rate (${c.management_fee_pct}%)`)
    : bad(`froze ${c?.management_fee_pct}, org default is ${oea.management_fee_pct}`);

  const expectedMgmt = Math.round(5_000_000 * Number(oea.management_fee_pct) / 100 * 100) / 100;
  Number(c?.management_fee_amount) === expectedMgmt
    ? ok(`the management fee is ₦${expectedMgmt.toLocaleString()} on ₦5,000,000 rent`)
    : bad(`fee was ${c?.management_fee_amount}, expected ${expectedMgmt}`);

  Number(c?.landlord_net_amount) === 5_000_000 - expectedMgmt - Number(c.admin_fee_amount)
    ? ok("and the landlord's net is the rent less the fees, to the naira")
    : bad(`net was ${c?.landlord_net_amount}`);

  // ⚠️ THE decision-14 claim: change the rate, and the existing charge must not move.
  const before = Number(c.management_fee_amount);
  await svc.from("orgs").update({ management_fee_pct: 25 }).eq("id", oea.id);
  const { data: after } = await svc.from("rent_charges").select("management_fee_pct, management_fee_amount").eq("id", charge.id).single();
  Number(after.management_fee_amount) === before
    ? ok("raising the org rate to 25% leaves the existing charge untouched")
    : bad(`A PAST STATEMENT WAS REWRITTEN: ${before} → ${after.management_fee_amount}`);
  await svc.from("orgs").update({ management_fee_pct: oea.management_fee_pct }).eq("id", oea.id);
}

console.log("\nC. A landlord's negotiated rate overrides the default");
{
  const { data: t } = await svc.from("landlord_terms").insert({
    org_id: oea.id, landlord_user_id: landlord.id, management_fee_pct: 5,
    note: `PROBELEASE-${S}`,
  }).select("id").single();
  if (t) made.terms.push(t.id);

  const { data: pct } = await svc.rpc("effective_management_fee_pct", {
    p_org_id: oea.id, p_landlord: landlord.id,
  });
  Number(pct) === 5
    ? ok("the landlord's 5% is what resolves, not the org default")
    : bad(`resolved ${pct}`);

  // A new charge picks up the negotiated rate.
  const { data: id2 } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2027-09-01", p_period_end: "2028-09-01",
  });
  const { data: c2 } = await svc.from("rent_charges").select("management_fee_pct").eq("id", id2).single();
  Number(c2.management_fee_pct) === 5
    ? ok("and the next charge is raised at that rate")
    : bad(`the new charge used ${c2.management_fee_pct}%`);

  // Resetting the override must FALL BACK to the default, not to zero.
  await svc.from("landlord_terms").update({ management_fee_pct: null }).eq("id", made.terms[0]);
  const { data: reset } = await svc.rpc("effective_management_fee_pct", {
    p_org_id: oea.id, p_landlord: landlord.id,
  });
  Number(reset) === Number(oea.management_fee_pct)
    ? ok("clearing the override falls back to the org default, not to zero")
    : bad(`reset resolved ${reset}, expected ${oea.management_fee_pct}`);
}

console.log("\nD. Rent cannot be written by hand, or billed twice");
{
  const admin = await login("oea.admin@oegroup.test");
  if (!admin) bad("could not sign in as the OEA administrator");
  else {
    const { error } = await admin.from("rent_charges").insert({
      org_id: oea.id, lease_id: lease.id,
      period_start: "2030-01-01", period_end: "2031-01-01", due_date: "2030-01-01",
      amount: 5_000_000, management_fee_pct: 0, management_fee_amount: 0,
      landlord_net_amount: 5_000_000,
    });
    error
      ? ok("an administrator cannot insert a charge claiming a 0% fee")
      : bad("A RENT CHARGE WAS HAND-WRITTEN WITH ITS OWN FEE");
    await admin.auth.signOut();
  }

  const { error: dup } = await svc.rpc("raise_rent_charge", {
    p_lease_id: lease.id, p_period_start: "2026-09-01", p_period_end: "2027-09-01",
  });
  dup ? ok("the same period cannot be billed twice") : bad("A PERIOD WAS BILLED TWICE");
}

console.log("\nE. Renewal escalates the new term, never the old");
{
  const originalRent = Number(lease.rent_amount);
  const { data: newId, error } = await svc.rpc("renew_lease", { p_lease_id: lease.id, p_months: 12 });
  if (error) bad(`renewal failed — ${error.message.slice(0, 70)}`);
  else {
    made.leases.push(newId);
    const { data: old } = await svc.from("leases").select("status, rent_amount").eq("id", lease.id).single();
    const { data: nw } = await svc.from("leases").select("status, rent_amount, start_date, renewed_from_lease_id").eq("id", newId).single();

    Number(old.rent_amount) === originalRent
      ? ok("the old term's rent is unchanged")
      : bad(`THE OLD TERM WAS REWRITTEN: ${originalRent} → ${old.rent_amount}`);
    old.status === "renewed" ? ok("and it is marked renewed") : bad(`old status is ${old.status}`);

    const expected = Math.round(originalRent * 1.1 * 100) / 100;
    Number(nw.rent_amount) === expected
      ? ok(`the new term carries the 10% escalation (₦${expected.toLocaleString()})`)
      : bad(`new rent is ${nw.rent_amount}, expected ${expected}`);
    nw.renewed_from_lease_id === lease.id
      ? ok("and points back at the term it replaced")
      : bad("the renewal chain is broken");
  }
}

console.log("\nF. A tenant sees their own tenancy and no one else's");
{
  const c = await login("oea.tenant@oegroup.test");
  if (!c) bad("could not sign in as the tenant");
  else {
    // ⚠️ This asserted only "no rows belong to anyone else", which passes when
    // the tenant can see NOTHING — and it did, silently, because rent_roll
    // joins tables a tenant has no read on. A "no bad rows" check is not a test
    // until it also proves there are rows.
    const { data: mine } = await c.rpc("my_tenancies");
    (mine ?? []).length > 0
      ? ok(`the tenant sees their own tenancy (${(mine ?? []).length} row(s))`)
      : bad("A TENANT CANNOT SEE THEIR OWN TENANCY");

    const theirLeases = new Set((mine ?? []).map((r) => r.lease_id));
    theirLeases.has(lease.id)
      ? ok("and it is the right one")
      : bad("the tenant's tenancy is not among the rows returned");

    // A second tenancy belonging to someone else must not appear.
    const otherTenant = (await svc.from("users")
      .select("id").eq("email", "oea.executive@oegroup.test").single()).data;
    const u3 = (await svc.from("units").insert({
      org_id: oea.id, property_id: prop.id, label: `Flat C ${S}`, apportionment_factor: 1,
    }).select("id").single()).data;
    made.units.push(u3.id);
    const foreignLease = (await svc.from("leases").insert({
      org_id: oea.id, property_id: prop.id, unit_id: u3.id,
      tenant_user_id: otherTenant.id,
      start_date: "2026-02-01", end_date: "2027-02-01",
      rent_amount: 9_000_000, status: "active",
    }).select("id").single()).data;
    made.leases.push(foreignLease.id);

    const { data: after } = await c.rpc("my_tenancies");
    (after ?? []).some((r) => r.lease_id === foreignLease.id)
      ? bad("A TENANT SAW ANOTHER PERSON'S TENANCY")
      : ok("and another tenant's lease does not appear");

    const { error } = await c.rpc("raise_rent_charge", {
      p_lease_id: lease.id, p_period_start: "2035-01-01", p_period_end: "2036-01-01",
    });
    error ? ok("and cannot bill rent to themselves") : bad("A TENANT RAISED A RENT CHARGE");
    await c.auth.signOut();
  }
}

console.log("\nG. Renewal notices fire once per threshold");
{
  // A lease expiring in exactly 90 days should appear; 89 should not.
  const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const in89 = new Date(Date.now() + 89 * 86_400_000).toISOString().slice(0, 10);

  const u2 = (await svc.from("units").insert({
    org_id: oea.id, property_id: prop.id, label: `Flat B ${S}`, apportionment_factor: 1,
  }).select("id").single()).data;
  made.units.push(u2.id);

  const due = (await svc.from("leases").insert({
    org_id: oea.id, property_id: prop.id, unit_id: u2.id,
    start_date: "2026-01-01", end_date: in90, rent_amount: 1_000_000, status: "active",
  }).select("id").single()).data;
  made.leases.push(due.id);

  const { data: notices } = await svc.rpc("leases_due_for_notice", { p_org_id: oea.id });
  (notices ?? []).some((n) => n.lease_id === due.id)
    ? ok("a lease expiring in exactly 90 days is due for notice")
    : bad("THE 90-DAY THRESHOLD DID NOT FIRE");

  await svc.from("leases").update({ end_date: in89 }).eq("id", due.id);
  const { data: notices2 } = await svc.rpc("leases_due_for_notice", { p_org_id: oea.id });
  (notices2 ?? []).some((n) => n.lease_id === due.id)
    ? bad("THE NOTICE RE-FIRED AT 89 DAYS — it would send every day until expiry")
    : ok("and does not fire again the next day");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("rent_charges").delete().in("lease_id", made.leases);
await svc.from("leases").update({ status: "terminated" }).in("id", made.leases);
await svc.from("leases").delete().in("id", made.leases);
await svc.from("landlord_terms").delete().in("id", made.terms);
await svc.from("property_stakeholders").delete().eq("property_id", prop.id);
await svc.from("units").delete().in("id", made.units);
await svc.from("properties").delete().in("id", made.properties);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a unit is let once, and a rate change never rewrites a past statement."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
