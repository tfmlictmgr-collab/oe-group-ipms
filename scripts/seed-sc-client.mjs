// The service-charge client, with something to administer.
//
// 0094 gave the client an organisation, a front door and nine logins; 0097 gave
// it a filing structure. It still held no properties, no vendors and no money,
// so nothing exercised the one thing it exists for — B4's chain:
//
//   vendor invoice → service verification → performance gate → recommendation
//                  → approval → remittance → advice → audit entry
//
// This seeds the smallest dataset that walks that chain honestly, both ways: a
// vendor who clears the performance gate and one who is blocked by it. A demo
// that only shows the happy path proves the button works, not the control.
//
// ⚠️ **Synthetic data, per B5** — the POC phase runs on sample data, never live
// client records. Names below are invented and are meant to read as invented.
//
// Re-runnable: everything is keyed on its own name/reference and cleared first.
// Usage: node scripts/seed-sc-client.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ⚠️ By SLUG. `delivery_brand = 'direct'` matches this org, the platform operator
// AND the POC — resolving on it is how verify-payment-gate ended up inserting
// against an org with no vendors.
const { data: org, error: orgErr } = await svc
  .from("orgs").select("id, name").eq("slug", "sc-client").is("deleted_at", null).maybeSingle();
if (orgErr || !org) {
  console.error("The service-charge client org is missing — run node scripts/migrate.mjs");
  process.exit(1);
}
const ORG = org.id;
console.log(`Seeding ${org.name}\n`);

async function userId(email) {
  const { data } = await svc.from("users").select("id").eq("email", email).maybeSingle();
  return data?.id ?? null;
}

const [fm, owner, tenant, finance] = await Promise.all([
  userId("sc-client.facilitymanager@oegroup.test"),
  userId("sc-client.propertyowner@oegroup.test"),
  userId("sc-client.tenant@oegroup.test"),
  userId("sc-client.financeapprover@oegroup.test"),
]);
if (!fm || !tenant || !finance) {
  console.error("The client's logins are missing — run node scripts/seed-org-logins.mjs");
  process.exit(1);
}

// ── The rest of the tree, built the way an FM builds it ───────────────────
//
// 0097 seeds down to LOCATION. A property is filed under a SITE, so the two
// levels between — PROJECT and SITE — are exactly what decision 8 says the FM
// creates inline while filing the first property in a new city. Doing it here
// makes the seeded data walk the full REGION → LOCATION → PROJECT → SITE →
// PROPERTY chain rather than stopping where the migration stopped.
//
// `site_node_id` is nullable and an unfiled property stays fully operable, so
// this is a demonstration of the hierarchy, not a requirement of it.
const { data: lagos } = await svc
  .from("org_nodes").select("id")
  .eq("org_id", ORG).eq("level", "location").eq("name", "Lagos")
  .is("deleted_at", null).maybeSingle();

async function node(parentId, level, name) {
  const { data: found } = await svc.from("org_nodes").select("id")
    .eq("org_id", ORG).eq("level", level).eq("name", name)
    .is("deleted_at", null).maybeSingle();
  if (found) return found.id;
  const { data, error } = await svc.from("org_nodes")
    .insert({ org_id: ORG, parent_id: parentId, level, name, path: "" })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

let siteFor = {};
if (lagos) {
  const project = await node(lagos, "project", "Island Service Charge Portfolio");
  siteFor = {
    "Harbourpoint Residences": await node(project, "site", "Harbourpoint Estate"),
    "Marina Business Court": await node(project, "site", "Marina Court Complex"),
  };
  console.log("  hierarchy: Lagos → Island Service Charge Portfolio → 2 sites");
}

// ── Properties, units and the annual budget ───────────────────────────────
const PROPERTIES = [
  {
    name: "Harbourpoint Residences",
    address: "18 Ozumba Mbadiwe Avenue, Victoria Island, Lagos",
    budget: { period: "2026", description: "Annual service charge 2026", total: 9_600_000 },
    units: [
      { label: "Tower A - 01", factor: 145, occupant: tenant },
      { label: "Tower A - 02", factor: 145 },
      { label: "Tower A - 03", factor: 110 },
      { label: "Tower B - 01", factor: 190 },
      { label: "Tower B - 02", factor: 190 },
      { label: "Tower B - 03", factor: 120 },
    ],
  },
  {
    name: "Marina Business Court",
    address: "7 Marina Road, Lagos Island, Lagos",
    budget: { period: "2026", description: "Annual service charge 2026", total: 6_300_000 },
    units: [
      { label: "Suite 1", factor: 240 },
      { label: "Suite 2", factor: 240 },
      { label: "Suite 3", factor: 180 },
      { label: "Suite 4", factor: 140 },
    ],
  },
];

{
  const names = PROPERTIES.map((p) => p.name);
  const { data: existing } = await svc
    .from("properties").select("id").eq("org_id", ORG).in("name", names);
  const ids = (existing ?? []).map((p) => p.id);
  if (ids.length) {
    const { data: budgets } = await svc.from("sc_budgets").select("id").in("property_id", ids);
    const budgetIds = (budgets ?? []).map((b) => b.id);
    if (budgetIds.length) await svc.from("service_charges").delete().in("budget_id", budgetIds);
    await svc.from("sc_budgets").delete().in("property_id", ids);
    await svc.from("property_stakeholders").delete().in("property_id", ids);
    await svc.from("units").delete().in("property_id", ids);
    await svc.from("properties").delete().in("id", ids);
    console.log(`  cleared ${ids.length} previously seeded propert${ids.length === 1 ? "y" : "ies"}`);
  }
}

const propIds = {};
for (const p of PROPERTIES) {
  const { data: prop, error } = await svc.from("properties")
    .insert({ org_id: ORG, name: p.name, address: p.address, site_node_id: siteFor[p.name] ?? null })
    .select("id").single();
  if (error) throw error;
  propIds[p.name] = prop.id;

  const { error: uErr } = await svc.from("units").insert(
    p.units.map((u) => ({
      org_id: ORG, property_id: prop.id, label: u.label,
      apportionment_factor: u.factor, occupant_user_id: u.occupant ?? null,
    }))
  );
  if (uErr) throw uErr;

  const { error: bErr } = await svc.from("sc_budgets").insert({
    org_id: ORG, property_id: prop.id, period: p.budget.period,
    description: p.budget.description, total_amount: p.budget.total, status: "draft",
  });
  if (bErr) throw bErr;

  console.log(`  ${p.name}: ${p.units.length} units, budget ₦${p.budget.total.toLocaleString()}`);
}

// Who manages and who owns — without these the FM and owner dashboards are
// correctly empty, which reads as a broken scope rather than an unassigned one.
const stakes = [
  { property_id: propIds["Harbourpoint Residences"], user_id: fm, relation: "manager" },
  { property_id: propIds["Marina Business Court"], user_id: fm, relation: "manager" },
];
if (owner) stakes.push({ property_id: propIds["Harbourpoint Residences"], user_id: owner, relation: "owner" });
for (const st of stakes) {
  await svc.from("property_stakeholders")
    .upsert({ org_id: ORG, ...st }, { onConflict: "property_id,user_id,relation" });
}
console.log(`  stakes: FM manages both, owner holds Harbourpoint`);

// ── The third-party FM providers ──────────────────────────────────────────
//
// Cleaning and security specifically, because that is what B1 names as the work
// OE Group coordinates and remits for on this client's behalf.
//
// Scores are built to straddle the gate: Brightpath clears the 70 threshold
// comfortably, Citadel does not. The gate is only demonstrated by a vendor it
// actually stops.
const PERIODS = ["2026-05", "2026-06", "2026-07"];
const VENDORS = [
  {
    name: "Brightpath Facility Services",
    service_category: "cleaning",
    contact_email: "ops@brightpath.example",
    contact_phone: "+2348030000101",
    histories: [[88, 92, 90, 86, 100], [90, 88, 92, 90, 100], [92, 90, 94, 88, 100]],
  },
  {
    name: "Citadel Guard Systems",
    service_category: "security",
    contact_email: "control@citadelguard.example",
    contact_phone: "+2348030000102",
    histories: [[58, 52, 60, 55, 70], [55, 48, 58, 52, 70], [60, 50, 55, 58, 70]],
  },
  {
    name: "Greenline Grounds & Waste",
    service_category: "landscaping",
    contact_email: "hello@greenline.example",
    contact_phone: "+2348030000103",
    histories: [[80, 78, 82, 84, 90], [82, 80, 84, 82, 90], [84, 82, 86, 86, 90]],
  },
];

{
  const names = VENDORS.map((v) => v.name);
  const { data: existing } = await svc
    .from("vendors").select("id").eq("org_id", ORG).in("name", names);
  const ids = (existing ?? []).map((v) => v.id);
  if (ids.length) {
    await svc.from("payments").delete().in("vendor_id", ids);
    await svc.from("vendor_evaluations").delete().in("vendor_id", ids);
    await svc.from("vendors").delete().in("id", ids);
    console.log(`  cleared ${ids.length} previously seeded vendor(s)`);
  }
}

const vendorIds = {};
for (const v of VENDORS) {
  const { data: vendor, error } = await svc.from("vendors").insert({
    org_id: ORG, name: v.name, service_category: v.service_category,
    contact_email: v.contact_email, contact_phone: v.contact_phone, status: "active",
  }).select("id").single();
  if (error) throw error;
  vendorIds[v.name] = vendor.id;

  const { error: eErr } = await svc.from("vendor_evaluations").insert(
    v.histories.map(([quality, response, completion, satisfaction, compliance], i) => ({
      org_id: ORG, vendor_id: vendor.id,
      quality_score: quality, response_score: response, completion_score: completion,
      satisfaction_score: satisfaction, compliance_score: compliance,
      period: PERIODS[i], notes: `Monthly evaluation for ${PERIODS[i]}`,
    }))
  );
  if (eErr) throw eErr;
  console.log(`  ${v.name} (${v.service_category}) — ${v.histories.length} evaluations`);
}

// ── The gate itself ───────────────────────────────────────────────────────
await svc.from("payment_settings").upsert({
  org_id: ORG,
  min_performance_score: 70,
  approval_threshold_amount: 1_000_000,
});
console.log(`  payment settings: gate at 70, approval threshold ₦1,000,000`);

// Three invoices, chosen to show the chain at rest in three different places —
// including one ABOVE the approval threshold, since the threshold escalation is
// a control an auditor checks and an all-small-amounts demo never shows it.
const PAYMENTS = [
  {
    vendor: "Brightpath Facility Services", invoice_reference: "SC-BPF-2026-014",
    amount: 780_000, status: "pending_verification", performance_validated: false,
    note: "clears the gate when verified",
  },
  {
    vendor: "Citadel Guard Systems", invoice_reference: "SC-CGS-2026-009",
    amount: 540_000, status: "pending_verification", performance_validated: false,
    note: "BLOCKED at the performance gate — score is below 70",
  },
  {
    vendor: "Greenline Grounds & Waste", invoice_reference: "SC-GGW-2026-003",
    amount: 1_250_000, status: "pending_verification", performance_validated: false,
    note: "above the ₦1,000,000 threshold — escalates to admin approval",
  },
];

await svc.from("payments").delete().eq("org_id", ORG)
  .in("invoice_reference", PAYMENTS.map((p) => p.invoice_reference));

const { error: payErr } = await svc.from("payments").insert(
  PAYMENTS.map((p) => ({
    org_id: ORG, vendor_id: vendorIds[p.vendor], invoice_reference: p.invoice_reference,
    amount: p.amount, status: p.status, performance_validated: p.performance_validated,
  }))
);
if (payErr) throw payErr;

console.log("\nVendor invoices awaiting the B4 chain:");
for (const p of PAYMENTS) {
  console.log(`  ${p.invoice_reference}  ₦${p.amount.toLocaleString().padStart(9)}  ${p.vendor}`);
  console.log(`      ${p.note}`);
}

console.log(`\nSign in at /o/sc-client — finance: sc-client.financeapprover@oegroup.test`);
console.log(`Password: OEGroupDemo2026!`);
