// Day 15 — master demo seed. ONE command: truncate + reseed the full,
// convincing demo dataset. Run: npm run seed  (→ npx tsx scripts/seed.mjs)
//
// Produces: 3 orgs (OE Group POC + TFML + OEA), all 7 role logins + 2 brand
// logins, 5 vendors with varied histories, 3 properties / 15 units, 2 SC billing
// cycles (2025 paid-off + 2026 part-paid), 20 tickets across every category and
// urgency, 3 payments in three different gate stages, and property-stakeholder
// assignments. Re-runnable and deterministic.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { apportion } from "../lib/apportionment.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const POC_ORG_ID = process.env.DEMO_ORG_ID; // preserved so webhooks keep working
const PASSWORD = "OEGroupDemo2026!";
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── 1. TRUNCATE all app data (audit_log's row-delete guard doesn't block
//        TRUNCATE; auth.users is untouched) ─────────────────────────────────
const pgc = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await pgc.connect();
await pgc.query(`truncate table
  notifications, audit_log, property_stakeholders, payment_settings, payments,
  service_charges, sc_budgets, units, properties, vendor_evaluations, vendors,
  tickets, users, orgs restart identity cascade;`);
await pgc.end();
console.log("Truncated all app tables.");

// ── 2. Orgs ────────────────────────────────────────────────────────────────
await supabase.from("orgs").insert({ id: POC_ORG_ID, name: "OE Group — Foundation POC", delivery_brand: "direct" });
const { data: tfmlOrg } = await supabase.from("orgs").insert({ name: "TFML — Total Facilities Management", delivery_brand: "TFML" }).select().single();
const { data: oeaOrg } = await supabase.from("orgs").insert({ name: "OEA — Ora Egbunike & Associates", delivery_brand: "OEA" }).select().single();
console.log("Orgs: POC + TFML + OEA");

// ── 3. Users (auth users reused across reseeds; profiles re-created) ────────
const { data: authList } = await supabase.auth.admin.listUsers();
async function ensureAuth(email) {
  let u = authList?.users?.find((x) => x.email === email);
  if (!u) {
    const { data, error } = await supabase.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    u = data.user;
  }
  return u.id;
}
async function profile(email, orgId, role, fullName) {
  const id = await ensureAuth(email);
  await supabase.from("users").insert({ id, org_id: orgId, role, full_name: fullName, email });
  return id;
}
const adminId = await profile("demo@oegroup.test", POC_ORG_ID, "admin", "Demo Admin");
const financeId = await profile("finance@oegroup.test", POC_ORG_ID, "finance_approver", "Oke Anderson");
const fmId = await profile("fm@oegroup.test", POC_ORG_ID, "facility_manager", "Abdul Owo");
const opsId = await profile("ops@oegroup.test", POC_ORG_ID, "fm_ops_staff", "Emeka Ade");
const ownerId = await profile("owner@oegroup.test", POC_ORG_ID, "property_owner", "Bola Adeyemi");
const vendorUserId = await profile("vendor@oegroup.test", POC_ORG_ID, "vendor", "Sparkle Cleaning (Vendor)");
const residentId = await profile("resident@oegroup.test", POC_ORG_ID, "tenant", "Tamuno Gab");
await profile("tfml@oegroup.test", tfmlOrg.id, "admin", "Ifeanyi Uche (TFML)");
await profile("oea@oegroup.test", oeaOrg.id, "admin", "Zainab Bello (OEA)");
console.log("Users: 7 POC roles + 2 brand admins");

// ── 4. Vendors + evaluation histories (0–100) ──────────────────────────────
const PERIODS = ["2026-04", "2026-05", "2026-06"];
const VENDORS = [
  { name: "Sparkle Cleaning Services", cat: "cleaning", hist: [[92,90,88,94,100],[95,92,90,96,100],[94,93,91,95,100]], link: vendorUserId },
  { name: "SecureGuard Ltd", cat: "security", hist: [[84,88,82,80,90],[86,90,84,82,90],[85,89,83,81,90]] },
  { name: "CoolAir HVAC", cat: "hvac", hist: [[70,62,68,72,80],[66,60,64,68,70],[72,65,70,74,80]] },
  { name: "GreenScape Landscaping", cat: "landscaping", hist: [[78,80,76,82,90],[72,74,70,76,80],[64,66,62,68,70]] },
  { name: "FixIt Plumbing", cat: "plumbing", hist: [[58,50,54,56,60],[52,46,48,52,60],[55,48,50,54,60]] },
];
const vendorIds = {};
for (const v of VENDORS) {
  const { data: vendor } = await supabase.from("vendors").insert({
    org_id: POC_ORG_ID, name: v.name, service_category: v.cat,
    contact_email: `ops@${v.cat}.example`, contact_phone: "+2348030000000",
    status: "active", user_id: v.link ?? null,
  }).select().single();
  vendorIds[v.name] = vendor.id;
  await supabase.from("vendor_evaluations").insert(
    v.hist.map(([q, r, c, s, cp], i) => ({
      org_id: POC_ORG_ID, vendor_id: vendor.id, quality_score: q, response_score: r,
      completion_score: c, satisfaction_score: s, compliance_score: cp, period: PERIODS[i],
    }))
  );
}
console.log(`Vendors: ${VENDORS.length} with ${PERIODS.length} evaluations each`);

// ── 5. Properties + 15 units ───────────────────────────────────────────────
const PROPERTIES = [
  { name: "Lekki Gardens Estate", address: "Km 22 Lekki-Epe Expressway, Lagos",
    units: [["Block A - Unit 1", 120, residentId], ["Block A - Unit 2", 120], ["Block A - Unit 3", 95], ["Block B - Unit 1", 150], ["Block B - Unit 2", 85], ["Block B - Unit 3", 110]] },
  { name: "Ikoyi Heights", address: "14 Bourdillon Road, Ikoyi, Lagos",
    units: [["Apt 1", 200], ["Apt 2", 180], ["Apt 3", 220], ["Apt 4", 160]] },
  { name: "Victoria Court", address: "3 Adeola Odeku Street, Victoria Island, Lagos",
    units: [["V1", 75], ["V2", 75], ["V3", 90], ["V4", 60], ["V5", 100]] },
];
const propIds = {};
const unitsByProp = {};
for (const p of PROPERTIES) {
  const { data: prop } = await supabase.from("properties").insert({ org_id: POC_ORG_ID, name: p.name, address: p.address }).select().single();
  propIds[p.name] = prop.id;
  const { data: units } = await supabase.from("units").insert(
    p.units.map(([label, factor, occ]) => ({ org_id: POC_ORG_ID, property_id: prop.id, label, apportionment_factor: factor, occupant_user_id: occ ?? null }))
  ).select();
  unitsByProp[p.name] = units;
}
const unitCount = PROPERTIES.reduce((a, p) => a + p.units.length, 0);
console.log(`Properties: ${PROPERTIES.length} · units: ${unitCount}`);

// ── 6. Two SC billing cycles (2025 fully paid, 2026 part-paid) ─────────────
const CYCLE_TOTALS = { "Lekki Gardens Estate": 7200000, "Ikoyi Heights": 5400000, "Victoria Court": 3000000 };
async function billingCycle(year, paidFraction) {
  for (const p of PROPERTIES) {
    const total = CYCLE_TOTALS[p.name] * (year === "2025" ? 0.92 : 1); // 2025 slightly lower
    const { data: budget } = await supabase.from("sc_budgets").insert({
      org_id: POC_ORG_ID, property_id: propIds[p.name], period: year,
      description: `Annual service charge ${year}`, total_amount: total, status: "invoiced",
    }).select().single();
    const units = unitsByProp[p.name];
    const shares = apportion(total, units.map((u) => ({ id: u.id, label: u.label, factor: Number(u.apportionment_factor), occupant_user_id: u.occupant_user_id })));
    const rows = shares.map((s, i) => ({
      org_id: POC_ORG_ID, budget_id: budget.id, unit_id: s.id, billed_to_user_id: s.occupant_user_id ?? null,
      property_or_unit: `${p.name} · ${s.label}`, billing_period: year, amount: s.amount,
      apportionment_pct: Number((s.pct * 100).toFixed(4)),
      status: i / shares.length < paidFraction ? "paid" : "invoiced",
    }));
    await supabase.from("service_charges").insert(rows);
  }
}
await billingCycle("2025", 1.0);   // historical: fully collected
await billingCycle("2026", 0.6);   // current: ~60% collected
console.log("SC cycles: 2025 (paid) + 2026 (part-paid)");

// ── 7. Property stakeholders ───────────────────────────────────────────────
await supabase.from("property_stakeholders").insert([
  { org_id: POC_ORG_ID, property_id: propIds["Lekki Gardens Estate"], user_id: fmId, relation: "manager" },
  { org_id: POC_ORG_ID, property_id: propIds["Ikoyi Heights"], user_id: fmId, relation: "manager" },
  { org_id: POC_ORG_ID, property_id: propIds["Lekki Gardens Estate"], user_id: ownerId, relation: "owner" },
]);
console.log("Stakeholders: FM → Lekki+Ikoyi · owner → Lekki");

// ── 8. 20 tickets across every category and urgency ────────────────────────
const CH = ["whatsapp", "telegram", "portal"];
const propList = Object.values(propIds);
const TICKETS = [
  ["Burst pipe flooding the lobby, water everywhere", "maintenance", "critical"],
  ["No power in Block C since morning, generator won't start", "maintenance", "critical"],
  ["Lift in Tower 2 stopped with someone inside", "maintenance", "critical"],
  ["AC in my flat has stopped cooling, very hot", "maintenance", "high"],
  ["Security gate motor faulty, opening by hand", "maintenance", "high"],
  ["Kitchen bulb blown, whenever you're chanced", "maintenance", "low"],
  ["Toilet seat loose, no rush", "maintenance", "low"],
  ["Corridor not cleaned in two weeks", "maintenance", "normal"],
  ["What is my service charge balance this year?", "billing", "normal"],
  ["Why is my invoice higher than last year?", "billing", "normal"],
  ["I paid last week but it still shows unpaid", "billing", "high"],
  ["Please send a receipt for my Q1 payment", "billing", "low"],
  ["Disputing the arrears, I cleared it in January", "billing", "high"],
  ["Sparkle Cleaning: Block A deep clean complete, invoice attached", "vendor", "normal"],
  ["SecureGuard: night shift done, submitting monthly invoice", "vendor", "normal"],
  ["Security men sleeping on duty, unacceptable", "complaint", "high"],
  ["Facility manager was very rude yesterday", "complaint", "normal"],
  ["Construction noise every night, nobody acting", "complaint", "normal"],
  ["Good morning", "general", "low"],
  ["What are the estate office hours?", "general", "low"],
];
const ticketRows = TICKETS.map((t, i) => ({
  org_id: POC_ORG_ID, channel: CH[i % 3], channel_sender_ref: `demo-${i}`,
  message_text: t[0], category: t[1], urgency: t[2], summary: t[0],
  property_id: propList[i % propList.length],
  status: i % 5 === 0 ? "resolved" : i % 5 === 1 ? "in_progress" : "open",
}));
await supabase.from("tickets").insert(ticketRows);
console.log(`Tickets: ${TICKETS.length} across all categories/urgencies`);

// ── 9. payment_settings + 3 payments in three gate stages ──────────────────
await supabase.from("payment_settings").insert({ org_id: POC_ORG_ID, min_performance_score: 70, approval_threshold_amount: 1000000 });
const now = Date.now();
await supabase.from("payments").insert([
  { org_id: POC_ORG_ID, vendor_id: vendorIds["FixIt Plumbing"], invoice_reference: "INV-FXP-0031", amount: 280000, status: "pending_verification", performance_validated: false },
  { org_id: POC_ORG_ID, vendor_id: vendorIds["SecureGuard Ltd"], invoice_reference: "INV-SEC-0019", amount: 620000, status: "recommended", performance_validated: true, service_verified_by: fmId, service_verified_at: new Date(now - 86400000).toISOString() },
  { org_id: POC_ORG_ID, vendor_id: vendorIds["Sparkle Cleaning Services"], invoice_reference: "INV-SPK-0007", amount: 450000, status: "remitted", performance_validated: true, service_verified_at: new Date(now - 3 * 86400000).toISOString(), approved_by: financeId, approved_at: new Date(now - 2 * 86400000).toISOString(), remittance_reference: "SIMULATED-POC-HISTORICAL" },
]);
console.log("Payments: 3 (pending_verification · recommended · remitted)");

// ── 10. Brand orgs: one ticket each (data-separation demo) ─────────────────
await supabase.from("tickets").insert([
  { org_id: tfmlOrg.id, channel: "portal", message_text: "AC servicing overdue in the east wing plant room — TFML site", category: "maintenance", urgency: "normal", summary: "AC servicing overdue — TFML site" },
  { org_id: oeaOrg.id, channel: "portal", message_text: "Tenancy renewal query for a managed property — OEA client", category: "general", urgency: "normal", summary: "Tenancy renewal query — OEA client" },
]);

console.log("\n✅ Demo dataset seeded. All logins: password " + PASSWORD);
console.log("   demo@ (admin) · finance@ · fm@ · ops@ · owner@ · vendor@ · resident@ · tfml@ · oea@");
