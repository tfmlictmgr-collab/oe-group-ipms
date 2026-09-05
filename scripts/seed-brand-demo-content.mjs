// Gives TFML and OEA their own lived-in demo content, matching seed.mjs's
// shapes but scoped per-org instead of dumping everything into the POC org.
// seed.mjs itself only ever gives TFML/OEA one placeholder ticket each ("data
// separation demo") — fine for proving isolation, not for a branded portal
// someone actually clicks around in.
//
// Additive, not destructive: does NOT truncate. Safe to re-run — each section
// checks for its own existing rows by a stable label before inserting, so a
// second run tops up rather than duplicating.
//
// Usage: node scripts/seed-brand-demo-content.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { apportion } from "../lib/apportionment.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const PASSWORD = "OEGroupDemo2026!";

async function ensureUser(email, orgId, role, fullName) {
  const { data: authList } = await svc.auth.admin.listUsers();
  let u = authList?.users?.find((x) => x.email === email);
  if (!u) {
    const { data, error } = await svc.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
      app_metadata: { org_id: orgId, role },
    });
    if (error) throw error;
    u = data.user;
  }
  await svc.from("users").upsert(
    { id: u.id, org_id: orgId, role, full_name: fullName, email },
    { onConflict: "id" }
  );
  return u.id;
}

const BRANDS = [
  {
    label: "TFML", brandKey: "TFML",
    property: { name: "Marina Business Park", address: "12 Marina, Lagos Island, Lagos",
      units: [["Suite 101", 100], ["Suite 102", 100], ["Suite 201", 140], ["Suite 202", 140], ["Suite 301", 90]] },
    vendors: [
      { name: "Apex Facilities Cleaning", cat: "cleaning", hist: [90, 92, 94] },
      { name: "Bright Spark Electricians", cat: "electrical", hist: [78, 82, 85] },
    ],
    tickets: [
      ["Generator servicing due end of month", "maintenance", "normal"],
      ["Fire extinguisher inspection overdue on floor 2", "maintenance", "high"],
      ["Water dispenser leaking in the lobby", "maintenance", "low"],
      ["Invoice for Q2 cleaning contract attached", "vendor", "normal"],
      ["Parking barrier not opening for staff cards", "maintenance", "high"],
      ["Confirming this month's service charge breakdown", "billing", "normal"],
    ],
    fmEmail: "tfml.fm@oegroup.test", fmName: "Chidi Okonkwo (TFML)",
    financeEmail: "tfml.finance@oegroup.test", financeName: "Amaka Nwosu (TFML)",
  },
  {
    label: "OEA", brandKey: "OEA",
    property: { name: "Parkview Terraces", address: "9 Gerrard Road, Ikoyi, Lagos",
      units: [["Terrace 1", 180], ["Terrace 2", 180], ["Terrace 3", 200], ["Terrace 4", 150]] },
    vendors: [
      { name: "GreenLeaf Landscaping", cat: "landscaping", hist: [88, 90, 91] },
      { name: "SafeHands Security", cat: "security", hist: [80, 83, 86] },
    ],
    tickets: [
      ["Gate intercom not working at the visitor entrance", "maintenance", "high"],
      ["Requesting a copy of my tenancy agreement", "general", "low"],
      ["Landscaping overdue, hedges overgrown", "maintenance", "normal"],
      ["Security invoice for August submitted", "vendor", "normal"],
      ["Rent statement shows a figure I don't recognise", "billing", "high"],
      ["Compound lighting out along the driveway", "maintenance", "normal"],
    ],
    fmEmail: "oea.fm@oegroup.test", fmName: "Funmi Alabi (OEA)",
    financeEmail: "oea.finance@oegroup.test", financeName: "Tunde Bakare (OEA)",
  },
];

for (const b of BRANDS) {
  const { data: org } = await svc.from("orgs").select("id, name")
    .eq("delivery_brand", b.brandKey).is("deleted_at", null).limit(2);
  if (!org || org.length !== 1) {
    console.error(`Skipping ${b.label}: expected exactly 1 org with delivery_brand=${b.brandKey}, found ${org?.length ?? 0}`);
    continue;
  }
  const orgId = org[0].id;
  console.log(`\n── ${org[0].name} ──`);

  const fmId = await ensureUser(b.fmEmail, orgId, "facility_manager", b.fmName);
  const financeId = await ensureUser(b.financeEmail, orgId, "finance_approver", b.financeName);
  console.log(`  Users: ${b.fmEmail}, ${b.financeEmail}`);

  // Property + units (skip if this property already exists for this org)
  let propId;
  const { data: existingProp } = await svc.from("properties")
    .select("id").eq("org_id", orgId).eq("name", b.property.name).maybeSingle();
  if (existingProp) {
    propId = existingProp.id;
    console.log(`  Property already exists: ${b.property.name}`);
  } else {
    // ⚠️ Every insert below is checked for .error and throws — a script that
    // discards it (as an earlier draft of this file did) leaves a property
    // with no units, or a budget with no charges, and crashes confusingly
    // several lines later on a null it never suspected.
    const { data: prop, error: propErr } = await svc.from("properties")
      .insert({ org_id: orgId, name: b.property.name, address: b.property.address })
      .select().single();
    if (propErr) throw new Error(`properties insert (${b.label}): ${propErr.message}`);
    propId = prop.id;
    const { data: units, error: unitsErr } = await svc.from("units").insert(
      b.property.units.map(([label, factor]) => ({ org_id: orgId, property_id: propId, label, apportionment_factor: factor }))
    ).select();
    if (unitsErr) throw new Error(`units insert (${b.label}): ${unitsErr.message}`);
    const { error: stakeErr } = await svc.from("property_stakeholders")
      .insert({ org_id: orgId, property_id: propId, user_id: fmId, relation: "manager" });
    if (stakeErr) throw new Error(`property_stakeholders insert (${b.label}): ${stakeErr.message}`);

    const total = b.property.units.reduce((s, [, f]) => s + f, 0) * 50000; // rough ₦/factor
    const { data: budget, error: budgetErr } = await svc.from("sc_budgets").insert({
      org_id: orgId, property_id: propId, period: "2026",
      description: "Annual service charge 2026", total_amount: total, status: "invoiced",
    }).select().single();
    if (budgetErr) throw new Error(`sc_budgets insert (${b.label}): ${budgetErr.message}`);
    const shares = apportion(total, units.map((u) => ({ id: u.id, label: u.label, factor: Number(u.apportionment_factor), occupant_user_id: null })));
    const { error: scErr } = await svc.from("service_charges").insert(shares.map((s, i) => ({
      org_id: orgId, budget_id: budget.id, unit_id: s.id, property_or_unit: `${b.property.name} · ${s.label}`,
      billing_period: "2026", amount: s.amount, apportionment_pct: Number((s.pct * 100).toFixed(4)),
      status: i / shares.length < 0.5 ? "paid" : "invoiced",
    })));
    if (scErr) throw new Error(`service_charges insert (${b.label}): ${scErr.message}`);
    console.log(`  Property: ${b.property.name} (${units.length} units, SC 2026 ~50% collected)`);
  }

  // Vendors
  const vendorIds = {};
  for (const v of b.vendors) {
    const { data: existing } = await svc.from("vendors")
      .select("id").eq("org_id", orgId).eq("name", v.name).maybeSingle();
    if (existing) { vendorIds[v.name] = existing.id; continue; }
    const { data: vendor, error: vendorErr } = await svc.from("vendors").insert({
      org_id: orgId, name: v.name, service_category: v.cat,
      contact_email: `ops@${v.cat}.example`, contact_phone: "+2348030000000", status: "active",
    }).select().single();
    if (vendorErr) throw new Error(`vendors insert (${b.label}/${v.name}): ${vendorErr.message}`);
    vendorIds[v.name] = vendor.id;
    await svc.from("vendor_evaluations").insert(
      v.hist.map((score, i) => ({
        org_id: orgId, vendor_id: vendor.id, quality_score: score, response_score: score - 4,
        completion_score: score - 2, satisfaction_score: score + 2, compliance_score: score + 6,
        period: `2026-0${4 + i}`,
      }))
    );
    await svc.from("vendor_properties").insert({ org_id: orgId, vendor_id: vendor.id, property_id: propId });
  }
  console.log(`  Vendors: ${b.vendors.map((v) => v.name).join(", ")}`);

  // Tickets (skip if this exact summary already exists for this org, so re-runs top up rather than duplicate)
  const { data: existingTickets } = await svc.from("tickets").select("summary").eq("org_id", orgId);
  const have = new Set((existingTickets ?? []).map((t) => t.summary));
  const newTickets = b.tickets
    .filter(([text]) => !have.has(text))
    .map(([text, category, urgency], i) => ({
      org_id: orgId, channel: ["whatsapp", "telegram", "portal"][i % 3], channel_sender_ref: `branddemo-${b.label}-${i}`,
      message_text: text, category, urgency, summary: text, property_id: propId,
      status: i % 4 === 0 ? "resolved" : i % 4 === 1 ? "in_progress" : "open",
      // 0117 refuses in_progress/assigned/acknowledged with nobody assigned —
      // the earlier version of this script omitted this and the whole batch
      // silently failed (unchecked .error) while claiming success.
      assigned_to_user_id: i % 4 === 1 ? fmId : null,
    }));
  if (newTickets.length) {
    const { error: tErr } = await svc.from("tickets").insert(newTickets);
    if (tErr) throw new Error(`tickets insert (${b.label}): ${tErr.message}`);
  }
  console.log(`  Tickets: ${newTickets.length} added (${b.tickets.length - newTickets.length} already existed)`);

  // Payments
  const vendorNames = Object.keys(vendorIds);
  const { data: existingPayments } = await svc.from("payments").select("invoice_reference").eq("org_id", orgId);
  const havePay = new Set((existingPayments ?? []).map((p) => p.invoice_reference));
  const payRefs = [`INV-${b.label}-0001`, `INV-${b.label}-0002`];
  const now = Date.now();
  const newPayments = [
    { org_id: orgId, vendor_id: vendorIds[vendorNames[0]], invoice_reference: payRefs[0], amount: 340000, status: "pending_verification", performance_validated: false },
    { org_id: orgId, vendor_id: vendorIds[vendorNames[1]], invoice_reference: payRefs[1], amount: 510000, status: "recommended", performance_validated: true, service_verified_by: fmId, service_verified_at: new Date(now - 86400000).toISOString() },
  ].filter((p) => !havePay.has(p.invoice_reference));
  if (newPayments.length) await svc.from("payments").insert(newPayments);
  console.log(`  Payments: ${newPayments.length} added (${2 - newPayments.length} already existed)`);
}

console.log("\n✅ Brand demo content ready. New per-brand logins (password " + PASSWORD + "):");
// ⚠️ `oea.fm@` is named here as a PROPERTY manager, which is what it is.
// This file seeds it as a `facility_manager`, and 0183 then converts every OEA
// facility_manager row to `property_manager` — that is the FM/PM split doing
// exactly what decision 18 says it should, since OEA's existing "facilities
// managers" were its property managers. The row moved; the email string did
// not. Printing it under an "fm" label sent people to sign in expecting a
// facilities manager and getting "Properties Manager" on screen, which reads
// as a broken login and is a correct database.
//
// OEA's real facilities manager is `oea.fmgr@` (seed-brand-roles.mjs), and
// TFML's `tfml.fm@` was never converted — hence the two brands differ here.
console.log("   TFML  facilities manager  tfml.fm@oegroup.test");
console.log("   TFML  payment officer     tfml.finance@oegroup.test");
console.log("   OEA   properties manager  oea.fm@oegroup.test   (a PM since 0183, despite the name)");
console.log("   OEA   payment officer     oea.finance@oegroup.test");
console.log("   OEA   facilities manager  oea.fmgr@oegroup.test (from seed-brand-roles.mjs)");
