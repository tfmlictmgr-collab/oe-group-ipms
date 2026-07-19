// Seeds 3 properties with units (floor-area apportionment factors) + one annual
// service-charge budget each, and a resident demo user assigned to a unit (so
// the resident-facing statement view can be demonstrated). Re-runnable.
// Usage: node scripts/seed-sc.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const ORG_ID = process.env.DEMO_ORG_ID;
const RESIDENT_EMAIL = process.env.DEMO_RESIDENT_EMAIL ?? "resident@oegroup.test";
const RESIDENT_PASSWORD =
  process.env.DEMO_RESIDENT_PASSWORD ?? "OEGroupResident2026!";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── resident demo user ─────────────────────────────────────────────────────
const { data: list } = await supabase.auth.admin.listUsers();
let resident = list?.users?.find((u) => u.email === RESIDENT_EMAIL);
if (!resident) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: RESIDENT_EMAIL,
    password: RESIDENT_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  resident = data.user;
  console.log(`Created resident user: ${RESIDENT_EMAIL}`);
}
await supabase.from("users").upsert({
  id: resident.id,
  org_id: ORG_ID,
  role: "tenant",
  full_name: "Adaeze Okafor",
  email: RESIDENT_EMAIL,
});

// ── properties / units / budgets ───────────────────────────────────────────
const PROPERTIES = [
  {
    name: "Lekki Gardens Estate",
    address: "Km 22 Lekki-Epe Expressway, Lagos",
    budget: { period: "2026", description: "Annual service charge 2026", total: 7200000 },
    units: [
      { label: "Block A - Unit 1", factor: 120, occupant: resident.id },
      { label: "Block A - Unit 2", factor: 120 },
      { label: "Block A - Unit 3", factor: 95 },
      { label: "Block B - Unit 1", factor: 150 },
      { label: "Block B - Unit 2", factor: 85 },
      { label: "Block B - Unit 3", factor: 110 },
    ],
  },
  {
    name: "Ikoyi Heights",
    address: "14 Bourdillon Road, Ikoyi, Lagos",
    budget: { period: "2026", description: "Annual service charge 2026", total: 5400000 },
    units: [
      { label: "Apt 1", factor: 200 },
      { label: "Apt 2", factor: 180 },
      { label: "Apt 3", factor: 220 },
      { label: "Apt 4", factor: 160 },
    ],
  },
  {
    name: "Victoria Court",
    address: "3 Adeola Odeku Street, Victoria Island, Lagos",
    budget: { period: "2026", description: "Annual service charge 2026", total: 3000000 },
    units: [
      { label: "V1", factor: 75 },
      { label: "V2", factor: 75 },
      { label: "V3", factor: 90 },
      { label: "V4", factor: 60 },
      { label: "V5", factor: 100 },
    ],
  },
];

// Clear prior seed by property name (cascade: invoices → budgets → units → props)
const names = PROPERTIES.map((p) => p.name);
const { data: existingProps } = await supabase
  .from("properties")
  .select("id")
  .eq("org_id", ORG_ID)
  .in("name", names);

if (existingProps && existingProps.length > 0) {
  const propIds = existingProps.map((p) => p.id);
  const { data: budgets } = await supabase
    .from("sc_budgets")
    .select("id")
    .in("property_id", propIds);
  const budgetIds = (budgets ?? []).map((b) => b.id);
  if (budgetIds.length)
    await supabase.from("service_charges").delete().in("budget_id", budgetIds);
  await supabase.from("sc_budgets").delete().in("property_id", propIds);
  await supabase.from("units").delete().in("property_id", propIds);
  await supabase.from("properties").delete().in("id", propIds);
  console.log(`Cleared ${propIds.length} previously seeded properties.`);
}

for (const p of PROPERTIES) {
  const { data: prop, error: pErr } = await supabase
    .from("properties")
    .insert({ org_id: ORG_ID, name: p.name, address: p.address })
    .select()
    .single();
  if (pErr) throw pErr;

  const unitRows = p.units.map((u) => ({
    org_id: ORG_ID,
    property_id: prop.id,
    label: u.label,
    apportionment_factor: u.factor,
    occupant_user_id: u.occupant ?? null,
  }));
  const { error: uErr } = await supabase.from("units").insert(unitRows);
  if (uErr) throw uErr;

  const { error: bErr } = await supabase.from("sc_budgets").insert({
    org_id: ORG_ID,
    property_id: prop.id,
    period: p.budget.period,
    description: p.budget.description,
    total_amount: p.budget.total,
    status: "draft",
  });
  if (bErr) throw bErr;

  console.log(
    `Seeded ${p.name}: ${p.units.length} units, budget ₦${p.budget.total.toLocaleString()}`
  );
}

console.log("\nResident login for statement view:");
console.log(`  Email:    ${RESIDENT_EMAIL}`);
console.log(`  Password: ${RESIDENT_PASSWORD}`);
console.log("  (occupant of Lekki Gardens Estate · Block A - Unit 1)");
