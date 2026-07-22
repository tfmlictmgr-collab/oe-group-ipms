// Assigns property stakeholders (FM manages / owner owns) and links existing POC
// tickets to properties, so the B7 property-scoped roles are demonstrable.
// Re-runnable. Usage: node scripts/seed-property-scoping.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const ORG_ID = process.env.DEMO_ORG_ID;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function userId(email) {
  const { data } = await supabase.from("users").select("id").eq("email", email).single();
  return data.id;
}
async function propId(name) {
  const { data } = await supabase
    .from("properties")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("name", name)
    .single();
  return data.id;
}

const fm = await userId("fm@oegroup.test");
const owner = await userId("owner@oegroup.test");
const lekki = await propId("Lekki Gardens Estate");
const ikoyi = await propId("Ikoyi Heights");
const victoria = await propId("Victoria Court");

// FM Abdul Owo manages Lekki + Ikoyi (not Victoria). Owner Bola owns Lekki.
const stakes = [
  { property_id: lekki, user_id: fm, relation: "manager" },
  { property_id: ikoyi, user_id: fm, relation: "manager" },
  { property_id: lekki, user_id: owner, relation: "owner" },
];
for (const st of stakes) {
  await supabase
    .from("property_stakeholders")
    .upsert({ org_id: ORG_ID, ...st }, { onConflict: "property_id,user_id,relation" });
}
console.log("Stakes: FM → Lekki Gardens + Ikoyi Heights · Owner → Lekki Gardens");

// Link POC tickets to properties round-robin so FM/owner scoping is visible.
const { data: tickets } = await supabase
  .from("tickets")
  .select("id")
  .eq("org_id", ORG_ID)
  .order("created_at");
const props = [lekki, ikoyi, victoria];
let i = 0;
for (const t of tickets ?? []) {
  await supabase.from("tickets").update({ property_id: props[i % 3] }).eq("id", t.id);
  i++;
}

// Distribution report
const counts = {};
for (const [name, id] of [["Lekki", lekki], ["Ikoyi", ikoyi], ["Victoria", victoria]]) {
  const { count } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .eq("property_id", id);
  counts[name] = count;
}
console.log(`Linked ${tickets?.length ?? 0} tickets →`, counts);
console.log(`\nExpected visibility: FM sees Lekki+Ikoyi (${counts.Lekki + counts.Ikoyi}), owner sees Lekki (${counts.Lekki}), admin/finance see all (${tickets?.length}).`);
