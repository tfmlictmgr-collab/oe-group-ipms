// The tenancy statement — /dashboard/leases/[id] — as each party actually
// reaches it.
//
// ⚠️ Written because the route did NOT EXIST. `LeaseStats` has linked every
// drawer card to `/dashboard/leases/<lease_id>` since the lettings tiles were
// made interactive, and every one of those cards led to the application's 404.
// A suite that only asked "does the query return rows" would have passed on the
// day no page rendered them, so §A asserts the ROUTE FILE is present before
// asking anything about data — the cheapest possible check, and the one that
// was missing.
//
// Every fixture below reads through a REAL logged-in client, never the service
// role. That is 0216's lesson: `verify-vendor-self-service` proved a policy
// worked while the product could not upload a single file, because every
// fixture in it wrote through the service role and never once sat in the
// subject's seat.
//
// Usage: node scripts/verify-tenancy-statement.mjs
import fs from "node:fs";
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
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) return null;
  const { data: { user } } = await c.auth.getUser();
  return { c, id: user.id, email };
}

// ── §A The route exists ───────────────────────────────────────────────────
head("§A The route the drawer links to");

const routeFile = path.join(rootDir, "app", "dashboard", "leases", "[id]", "page.tsx");
if (fs.existsSync(routeFile)) ok("app/dashboard/leases/[id]/page.tsx exists");
else bad("app/dashboard/leases/[id]/page.tsx is MISSING — every lettings drawer card 404s");

// And that the drawer still points where we think it does. If someone changes
// the href, this suite must stop claiming to cover it.
const statsFile = fs.readFileSync(
  path.join(rootDir, "app", "dashboard", "leases", "LeaseStats.tsx"), "utf8"
);
if (/href:\s*`\/dashboard\/leases\/\$\{r\.lease_id\}`/.test(statsFile)) {
  ok("LeaseStats still links drawer cards to /dashboard/leases/<lease_id>");
} else {
  bad("LeaseStats no longer links to /dashboard/leases/<lease_id> — this suite covers the wrong route");
}

// Every OTHER stat drawer in the dashboard links to a detail route. Assert that
// as a set, so the next drawer added with a dead href is caught here rather
// than by a person clicking it.
const drawerHrefs = [];
for (const rel of [
  ["app", "dashboard", "RequestStats.tsx"],
  ["app", "dashboard", "properties", "PropertyStats.tsx"],
  ["app", "dashboard", "my-jobs", "JobStats.tsx"],
  ["app", "dashboard", "my-work", "WorkStats.tsx"],
  ["app", "dashboard", "leases", "LeaseStats.tsx"],
  ["app", "dashboard", "approvals", "page.tsx"],
]) {
  const src = fs.readFileSync(path.join(rootDir, ...rel), "utf8");
  for (const m of src.matchAll(/href:\s*`(\/dashboard\/[^`]*)`/g)) drawerHrefs.push(m[1]);
}
const deadHrefs = drawerHrefs.filter((h) => {
  // `/dashboard/a/${x}/b` → app/dashboard/a/[id]/b
  const segs = h.split("/").filter(Boolean).slice(1);
  const dir = path.join(rootDir, "app", "dashboard",
    ...segs.map((s) => (s.startsWith("${") ? "__DYN__" : s)));
  // Resolve the dynamic segment against whatever the folder is actually called.
  let cur = path.join(rootDir, "app", "dashboard");
  for (const s of segs) {
    if (s.startsWith("${")) {
      const dyn = fs.existsSync(cur)
        ? fs.readdirSync(cur).find((d) => d.startsWith("[") && d.endsWith("]"))
        : null;
      if (!dyn) return true;
      cur = path.join(cur, dyn);
    } else {
      cur = path.join(cur, s);
    }
  }
  return !fs.existsSync(path.join(cur, "page.tsx")) && dir !== null;
});
if (deadHrefs.length === 0) ok(`all ${drawerHrefs.length} drawer hrefs resolve to a page.tsx`);
else bad(`drawer hrefs with no route: ${deadHrefs.join(", ")}`);

// ── Fixtures ──────────────────────────────────────────────────────────────
const { data: orgs } = await svc
  .from("orgs").select("id, slug, delivery_brand").is("deleted_at", null);
const oea = orgs.find((o) => o.slug === "oea");
const tfml = orgs.find((o) => o.slug === "tfml");
if (!oea) { console.error("No live OEA org — cannot run."); process.exit(1); }

// A lease that actually has rent charges, so the schedule has something in it.
const { data: leases } = await svc
  .from("leases")
  .select("id, status, tenant_user_id, property_id, unit_id, currency")
  .eq("org_id", oea.id).is("deleted_at", null)
  .in("status", ["active", "renewed"]);
const { data: allCharges } = await svc
  .from("rent_charges")
  .select("id, lease_id, amount, amount_paid, management_fee_amount, landlord_net_amount")
  .in("lease_id", (leases ?? []).map((l) => l.id));

const chargeCount = {};
for (const c of allCharges ?? []) chargeCount[c.lease_id] = (chargeCount[c.lease_id] ?? 0) + 1;

// ⚠️ Prefer a lease on a property an FM/PM actually MANAGES. The first run of
// this suite picked a leftover probe-fixture property whose only stakeholder was
// an owner, so the FM/PM branch read zero — correctly, since they hold nothing
// there — and the suite reported a failure that was the rule working. A fixture
// chosen at random exercises whichever branch it happens to land on; this one
// is chosen to exercise the branch under test, and §B/§C still assert the RULE
// (does what they read agree with what they hold) rather than the instance.
const PM_EMAIL = "oea.facilitymanager@oegroup.test";
const { data: pmUser } = await svc
  .from("users").select("id").eq("email", PM_EMAIL).maybeSingle();
const { data: managed } = pmUser
  ? await svc.from("property_stakeholders")
      .select("property_id").eq("user_id", pmUser.id).eq("relation", "manager")
  : { data: [] };
const managedProps = new Set((managed ?? []).map((m) => m.property_id));

const candidates = (leases ?? []).filter((l) => chargeCount[l.id] && l.tenant_user_id);
const lease =
  candidates.find((l) => managedProps.has(l.property_id)) ?? candidates[0];
if (!lease) { console.error("No OEA lease with rent charges and a tenant — cannot run."); process.exit(1); }
const pmHoldsProperty = managedProps.has(lease.property_id);

const { data: tenantRow } = await svc
  .from("users").select("email").eq("id", lease.tenant_user_id).maybeSingle();

console.log(`\n  lease ${lease.id} · ${lease.status} · ${chargeCount[lease.id]} charge(s) · tenant ${tenantRow?.email}`);

const pm = await login("oea.facilitymanager@oegroup.test");
const finance = await login("oea.financeapprover@oegroup.test");
const tenant = await login(tenantRow?.email);
const owner = await login("oea.propertyowner@oegroup.test");
const tfmlAdmin = tfml ? await login("tfml.admin@oegroup.test") : null;

// Exactly the page's own read. If this returns nothing, the page 404s.
const readLease = (client) =>
  client.from("leases").select(
    "id, org_id, property_id, unit_id, tenant_user_id, start_date, end_date, status, " +
    "rent_amount, rent_frequency, paid_in_advance, currency, escalation_pct, deposit_amount, " +
    "notes, created_at, renewed_from_lease_id, " +
    "properties(name, address), units(label, unit_quantity), users:tenant_user_id(full_name, email, phone)"
  ).eq("id", lease.id).maybeSingle();

// ── §B Who can open it ────────────────────────────────────────────────────
head("§B Who the page opens for — leases_select, and nothing repeated on top");

for (const [who, sess, expect] of [
  // The FM/PM's expectation is the RULE, not a constant: they read it exactly
  // when they hold the property. Asserting `true` unconditionally would report
  // the policy working as a failure on any fixture they do not manage.
  [`the FM/PM (holds this property: ${pmHoldsProperty})`, pm, pmHoldsProperty],
  ["finance (oversight)", finance, true],
  ["the tenancy's own tenant", tenant, true],
]) {
  if (!sess) { bad(`${who}: could not sign in`); continue; }
  const { data, error } = await readLease(sess.c);
  if (error) bad(`${who}: the page's own query errored — ${error.message}`);
  else if (Boolean(data) === expect) ok(`${who} reads the tenancy${data ? "" : " (correctly not)"}`);
  else bad(`${who}: expected ${expect ? "a row" : "no row"}, got ${data ? "a row" : "none"}`);
}

// A landlord is NOT automatically an owner of THIS property, so this asserts the
// rule rather than the instance: whatever they get back, it must agree with
// whether they hold the property.
if (owner) {
  const { data: holds } = await svc
    .from("property_stakeholders").select("id")
    .eq("property_id", lease.property_id).eq("relation", "owner")
    .eq("user_id", owner.id).maybeSingle();
  const { data } = await readLease(owner.c);
  if (Boolean(data) === Boolean(holds)) {
    ok(`a landlord reads it only when they own the property (owns: ${Boolean(holds)})`);
  } else {
    bad(`a landlord ${holds ? "owns the property but cannot read" : "does NOT own the property but can read"} the tenancy`);
  }
}

// The isolation rule. A different brand's administrator is the strongest form
// of "someone with authority, in the wrong org".
if (tfmlAdmin) {
  const { data } = await readLease(tfmlAdmin.c);
  if (!data) ok("the other brand's administrator gets no row — B1 holds");
  else bad("⚠️ the other brand's administrator can read an OEA tenancy");
} else {
  console.log("  \x1b[33mSKIP\x1b[0m no TFML admin fixture on this world");
}

// A lease id that does not exist must be indistinguishable from one this caller
// may not read — both are `notFound()`, so the page cannot be used to probe
// which ids are real.
if (tenant) {
  const other = (leases ?? []).find((l) => l.tenant_user_id !== lease.tenant_user_id);
  const { data: fake } = await tenant.c.from("leases").select("id")
    .eq("id", "00000000-0000-0000-0000-000000000000").maybeSingle();
  const { data: notMine } = other
    ? await tenant.c.from("leases").select("id").eq("id", other.id).maybeSingle()
    : { data: null };
  if (!fake && !notMine) ok("a nonexistent id and someone else's tenancy both read as no row");
  else bad("a tenant can distinguish a real tenancy they may not see from one that does not exist");
}

// ── §C The schedule the page renders ──────────────────────────────────────
head("§C The rent schedule, and the position it totals");

// ⚠️ The tenant left this loop in 0229. They no longer hold a direct read on
// `rent_charges` at all — the row carries the fee split — and reach their own
// schedule through `my_rent_charges()` instead. That they still see every one
// of their demands is asserted in §D, where the narrowing is proved; asserting
// it here as well against the wrong surface would just re-fail the same fact.
for (const [who, sess, expected] of [
  ["FM/PM", pm, pmHoldsProperty ? chargeCount[lease.id] : 0],
  ["finance", finance, chargeCount[lease.id]],
]) {
  if (!sess) continue;
  const { data, error } = await sess.c
    .from("rent_charges")
    .select("id, period_start, period_end, due_date, amount, amount_paid, currency, status, " +
            "management_fee_pct, management_fee_amount, admin_fee_amount, landlord_net_amount, remitted_at")
    .eq("lease_id", lease.id)
    .order("period_start", { ascending: false });
  if (error) bad(`${who}: the schedule query errored — ${error.message}`);
  else if ((data ?? []).length === expected) {
    ok(`${who} reads ${data.length} demand(s) on the tenancy — as the policy allows`);
  } else {
    bad(`${who}: expected ${expected} demand(s), got ${(data ?? []).length}`);
  }
}

// The totals the tiles show must be arithmetic on those rows and nothing else —
// no second source that could disagree with the schedule beneath it. Asked as
// whoever can actually see the tenancy, so the comparison is between two reads
// by ONE person rather than between two different people's scopes.
const roller = pmHoldsProperty ? pm : finance;
if (roller) {
  const { data } = await roller.c.from("rent_charges")
    .select("amount, amount_paid").eq("lease_id", lease.id);
  const billed = data.reduce((a, c) => a + Number(c.amount), 0);
  const collected = data.reduce((a, c) => a + Number(c.amount_paid), 0);
  const { data: roll } = await roller.c.from("rent_roll")
    .select("rent_billed, rent_collected, rent_outstanding").eq("lease_id", lease.id).maybeSingle();
  if (!roll) {
    bad("the rent roll does not carry this lease — the tile and the row would disagree");
  } else if (
    Math.abs(Number(roll.rent_billed) - billed) < 0.01 &&
    Math.abs(Number(roll.rent_collected) - collected) < 0.01
  ) {
    ok(`the detail page's totals match the rent roll (₦${billed.toLocaleString()} billed)`);
  } else {
    bad(`detail totals ${billed}/${collected} disagree with the roll ${roll.rent_billed}/${roll.rent_collected}`);
  }
}

// ── §D The fee split is not shown to the tenant ───────────────────────────
head("§D What a landlord is charged stays between the landlord and OE Group");

const pageSrc = fs.readFileSync(routeFile, "utf8");
if (/seesFeeSplit/.test(pageSrc) &&
    /viewerIsTenant/.test(pageSrc) &&
    /seesFeeSplit\s*&&\s*<TableHead[^>]*>\s*Fees/.test(pageSrc.replace(/\s+/g, " "))) {
  ok("the Fees column renders only behind seesFeeSplit");
} else if (/seesFeeSplit/.test(pageSrc) && /viewerIsTenant/.test(pageSrc)) {
  ok("the page gates the fee split on who is looking (seesFeeSplit / viewerIsTenant)");
} else {
  bad("the page does not gate the fee split — a tenant would read the landlord's management fee");
}

// ── The exposure underneath the page gate, now closed (0229) ─────────────
//
// This block used to print a NOTE saying `rent_charges_select` still let a
// tenant SELECT the fee columns directly, and that it was "not reachable on any
// screen". ⚠️ The second half was wrong: `rent_roll` is security_invoker and
// publishes the same sums as columns literally named `management_fees` and
// `landlord_net`, and `/dashboard/leases` carries no role guard — so a tenant
// who typed that URL was rendered a column headed "Landlord net". The NOTE is
// now four assertions, because a printed note does not fail a build.
if (tenant) {
  const direct = await tenant.c.from("rent_charges")
    .select("id, management_fee_amount, landlord_net_amount").eq("lease_id", lease.id);
  (direct.data ?? []).length === 0
    ? ok("a tenant reads no rent_charges row directly — the fee columns are out of reach")
    : bad(`a tenant still SELECTs ${direct.data.length} rent_charges row(s) carrying the fee split`);

  // The screen-level half, and the one that made this worth doing.
  const roll = await tenant.c.from("rent_roll")
    .select("lease_id, management_fees, landlord_net");
  (roll.data ?? []).length === 0
    ? ok("and no rent_roll row — the view states the two audiences it is for")
    : bad(`a tenant reads ${roll.data.length} rent_roll row(s); /dashboard/leases renders "Landlord net" to them`);

  // ⚠️ And the other direction, which is the whole point of 0091b's lesson: a
  // narrowing that also removed the tenant's own schedule would pass both
  // checks above and be a worse bug than the one it fixed.
  const mine = await tenant.c.rpc("my_rent_charges");
  const forLease = (mine.data ?? []).filter((r) => r.lease_id === lease.id);
  forLease.length === chargeCount[lease.id]
    ? ok(`the tenant still sees all ${forLease.length} of their own demand(s) via my_rent_charges()`)
    : bad(`the tenant sees ${forLease.length} of ${chargeCount[lease.id]} demand(s) — the narrowing took their statement with it`);

  const feeCols = Object.keys(mine.data?.[0] ?? {})
    .filter((k) => /fee|landlord_net/.test(k));
  feeCols.length === 0
    ? ok("and my_rent_charges() returns no fee column of any kind")
    : bad(`my_rent_charges() leaks ${feeCols.join(", ")}`);
}

// The fix must not have overshot: the fee split IS the landlord's own statement
// line, and whoever holds the property reads it through the same two surfaces.
{
  const holder = pmHoldsProperty ? pm : finance;
  if (holder) {
    const { data } = await holder.c.from("rent_roll")
      .select("lease_id, management_fees, landlord_net").eq("lease_id", lease.id).maybeSingle();
    data
      ? ok(`whoever holds the property still reads the fee split (net ₦${Number(data.landlord_net).toLocaleString()})`)
      : bad("the narrowing overshot — the property's own manager lost the rent roll");
  }
}

// ── §E Receipts come from the charge, not the unit ────────────────────────
head("§E Receipts join through the charge, so they cannot silently be empty");

if (finance) {
  const ids = (allCharges ?? []).filter((c) => c.lease_id === lease.id).map((c) => c.id);
  const { data: byCharge, error } = await finance.c
    .from("payment_intents")
    .select("id, gateway_reference, purpose, amount_expected, amount_paid, currency, status, paid_at, created_at")
    .or(`rent_charge_id.in.(${ids.join(",")})`);
  if (error) bad(`the receipts query errored — ${error.message}`);
  else ok(`finance reads ${byCharge.length} receipt(s) joined through rent_charge_id`);

  // The reason the page does not key on the unit: it is not populated on every
  // intent path, so a unit-keyed query would return an empty list on a tenancy
  // that has genuinely been paid.
  const { count: unitKeyed } = await svc
    .from("payment_intents").select("id", { count: "exact", head: true })
    .not("rent_charge_id", "is", null).is("unit_id", null);
  if (unitKeyed > 0) {
    ok(`${unitKeyed} rent intent(s) carry no unit_id — keying receipts on the unit would have missed them`);
  } else {
    console.log("  \x1b[33mNOTE\x1b[0m every rent intent currently carries a unit_id; " +
                "the charge join is still the correct key, since nothing requires it to.");
  }
}

// A tenant reads their own receipts and nobody else's — payment_intents_select
// is payer-or-oversight, and this page must not have widened it.
if (tenant) {
  const { data } = await tenant.c
    .from("payment_intents").select("id, payer_user_id").limit(200);
  const foreign = (data ?? []).filter((i) => i.payer_user_id !== tenant.id);
  if (foreign.length === 0) ok("a tenant reads only payment intents they are the payer of");
  else bad(`a tenant reads ${foreign.length} payment intent(s) belonging to someone else`);
}

// An FM/PM reads none, and that is the boundary rather than a gap — the page
// computes the position from rent_charges, which they do hold.
if (pm) {
  const { data } = await pm.c.from("payment_intents").select("id").limit(5);
  if ((data ?? []).length === 0) {
    ok("an FM/PM reads no payment intents (existing boundary; the page does not widen it)");
  } else {
    console.log(`  \x1b[33mNOTE\x1b[0m this FM/PM reads ${data.length} payment intent(s) — ` +
                "check whether payment_intents_select has been widened since 0072a.");
  }
}

// ── §F Service charge on the unit ─────────────────────────────────────────
head("§F The service charge shown beside the rent");

if (finance) {
  const { data, error } = await finance.c
    .from("service_charges")
    .select("id, billing_period, property_or_unit, amount, amount_paid, apportionment_pct, status, due_date")
    .eq("unit_id", lease.unit_id).is("deleted_at", null);
  if (error) bad(`the service-charge query errored — ${error.message}`);
  else ok(`finance reads ${data.length} service-charge invoice(s) on the unit`);
}

if (tenant) {
  const { data } = await tenant.c
    .from("service_charges").select("id, billed_to_user_id, unit_id").limit(200);
  const foreign = (data ?? []).filter(
    (c) => c.billed_to_user_id && c.billed_to_user_id !== tenant.id
  );
  if (foreign.length === 0) ok("a tenant reads no service charge billed to someone else");
  else bad(`a tenant reads ${foreign.length} service charge(s) billed to another person`);
}

// ── §G The statement can say whose home it is about ──────────────────────
head("§G A tenant can name the home they rent (0226) — and nothing more");

if (tenant) {
  const { data: prop } = await tenant.c
    .from("properties").select("id, name, address").eq("id", lease.property_id).maybeSingle();
  const { data: unit } = await tenant.c
    .from("units").select("id, label").eq("id", lease.unit_id).maybeSingle();

  if (prop?.name) ok(`the tenant reads their property by name — "${prop.name}"`);
  else bad("the tenant cannot read their own property — the statement renders the fallback \"Property\"");

  if (unit?.label) ok(`the tenant reads their unit by label — "${unit.label}"`);
  else bad("the tenant cannot read their own unit — the statement renders the fallback \"Unit\"");

  // ⚠️ The widening has to be exactly as wide as it says. Every property and
  // unit the tenant can read must be one they hold a lease on — otherwise 0226
  // has handed a tenant the property register.
  const { data: myLeases } = await svc
    .from("leases").select("property_id, unit_id")
    .eq("tenant_user_id", tenant.id).is("deleted_at", null);
  const okProps = new Set((myLeases ?? []).map((l) => l.property_id));
  const okUnits = new Set((myLeases ?? []).map((l) => l.unit_id));

  const { data: allProps } = await tenant.c.from("properties").select("id, name");
  const strayProps = (allProps ?? []).filter((p) => !okProps.has(p.id));
  if (strayProps.length === 0) {
    ok(`every one of the ${(allProps ?? []).length} properties the tenant reads is one they rent`);
  } else {
    bad(`⚠️ the tenant reads ${strayProps.length} property/ies they hold no tenancy on: ${strayProps.map((p) => p.name).join(", ")}`);
  }

  const { data: allUnits } = await tenant.c.from("units").select("id, label, occupant_user_id");
  const strayUnits = (allUnits ?? []).filter(
    (u) => !okUnits.has(u.id) && u.occupant_user_id !== tenant.id
  );
  if (strayUnits.length === 0) {
    ok(`every one of the ${(allUnits ?? []).length} units the tenant reads is one they rent or occupy`);
  } else {
    bad(`⚠️ the tenant reads ${strayUnits.length} unit(s) that are neither theirs nor occupied by them`);
  }
}

// Someone with no tenancy at all must gain nothing from 0226. A vendor is the
// clearest case: an authenticated user of the same org, holding no lease.
const vendor = await login("oea.vendor@oegroup.test");
if (vendor) {
  const { data: vp } = await vendor.c.from("properties").select("id");
  if ((vp ?? []).length === 0) ok("a vendor still reads no properties — 0226 grants nothing without a tenancy");
  else bad(`a vendor reads ${vp.length} property/ies — 0226 widened more than a tenancy`);
}

// And staff must be untouched. The branch was added beside the existing ones,
// never in place of them.
if (finance) {
  const { data: fp } = await finance.c.from("properties").select("id");
  const { count: orgProps } = await svc
    .from("properties").select("id", { count: "exact", head: true })
    .eq("org_id", oea.id).is("deleted_at", null);
  if ((fp ?? []).length === orgProps) {
    ok(`finance still reads all ${orgProps} properties in the org — the existing branches survived the rewrite`);
  } else {
    bad(`finance reads ${(fp ?? []).length} of ${orgProps} properties — a clause was lost rewriting properties_select`);
  }
}

// ── §H The table does not contradict itself ──────────────────────────────
head("§H One column, one question");

// The first render of this page totalled fees and landlord net on a
// COLLECTED basis while each row showed them on a DEMANDED basis, so a single
// row reading "₦600,000" sat above a total reading "₦0.00". Both figures were
// correct and the screen was still wrong. Asserted here because it is the
// decision-24 fault — two sources of truth on one screen — and prose in a
// comment does not stop it coming back.
if (/const landlordNet = charges\.reduce\(\(a, c\) => a \+ Number\(c\.landlord_net_amount\), 0\)/.test(pageSrc)) {
  ok("the landlord-net total is a plain sum of the rows above it");
} else {
  bad("the landlord-net total is not a plain sum of the rows — the table can contradict itself");
}
if (/amount_paid\s*\/\s*Number\(c\.amount\)/.test(pageSrc)) {
  bad("the totals apportion to what was collected while the rows show what was demanded — one column, two questions");
} else {
  ok("no collected-basis apportionment in the totals row");
}

console.log(
  failures === 0
    ? "\n\x1b[32m✔ tenancy statement: all checks passed\x1b[0m"
    : `\n\x1b[31m✘ ${failures} check(s) failed\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
