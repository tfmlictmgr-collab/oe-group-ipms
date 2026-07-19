// Seeds 5 synthetic vendors with 3 monthly evaluations each (0–100 scale) in
// the demo org. The DB computes composite_score; this just supplies the five
// component scores. Re-runnable: clears prior seeded vendors by name first.
// Usage: node scripts/seed-vendors.mjs
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

const PERIODS = ["2026-04", "2026-05", "2026-06"];

// [quality, response, completion, satisfaction, compliance] per period
const VENDORS = [
  {
    name: "Sparkle Cleaning Services",
    service_category: "cleaning",
    contact_email: "ops@sparkleclean.example",
    contact_phone: "+2348030000001",
    histories: [
      [92, 90, 88, 94, 100],
      [95, 92, 90, 96, 100],
      [94, 93, 91, 95, 100],
    ],
  },
  {
    name: "SecureGuard Ltd",
    service_category: "security",
    contact_email: "control@secureguard.example",
    contact_phone: "+2348030000002",
    histories: [
      [84, 88, 82, 80, 90],
      [86, 90, 84, 82, 90],
      [85, 89, 83, 81, 90],
    ],
  },
  {
    name: "CoolAir HVAC",
    service_category: "hvac",
    contact_email: "service@coolair.example",
    contact_phone: "+2348030000003",
    histories: [
      [70, 62, 68, 72, 80],
      [66, 60, 64, 68, 70],
      [72, 65, 70, 74, 80],
    ],
  },
  {
    name: "GreenScape Landscaping",
    service_category: "landscaping",
    contact_email: "hello@greenscape.example",
    contact_phone: "+2348030000004",
    histories: [
      [78, 80, 76, 82, 90],
      [72, 74, 70, 76, 80],
      [64, 66, 62, 68, 70],
    ],
  },
  {
    name: "FixIt Plumbing",
    service_category: "plumbing",
    contact_email: "jobs@fixitplumbing.example",
    contact_phone: "+2348030000005",
    histories: [
      [58, 50, 54, 56, 60],
      [52, 46, 48, 52, 60],
      [55, 48, 50, 54, 60],
    ],
  },
];

// Clear prior seed (evaluations cascade-free, so delete them first).
const names = VENDORS.map((v) => v.name);
const { data: existing } = await supabase
  .from("vendors")
  .select("id")
  .eq("org_id", ORG_ID)
  .in("name", names);

if (existing && existing.length > 0) {
  const ids = existing.map((v) => v.id);
  await supabase.from("vendor_evaluations").delete().in("vendor_id", ids);
  await supabase.from("vendors").delete().in("id", ids);
  console.log(`Cleared ${ids.length} previously seeded vendors.`);
}

for (const v of VENDORS) {
  const { data: vendor, error: vErr } = await supabase
    .from("vendors")
    .insert({
      org_id: ORG_ID,
      name: v.name,
      service_category: v.service_category,
      contact_email: v.contact_email,
      contact_phone: v.contact_phone,
      status: "active",
    })
    .select()
    .single();
  if (vErr) throw vErr;

  const rows = v.histories.map(([quality, response, completion, satisfaction, compliance], i) => ({
    org_id: ORG_ID,
    vendor_id: vendor.id,
    quality_score: quality,
    response_score: response,
    completion_score: completion,
    satisfaction_score: satisfaction,
    compliance_score: compliance,
    period: PERIODS[i],
    notes: `Monthly evaluation for ${PERIODS[i]}`,
  }));
  const { error: eErr } = await supabase.from("vendor_evaluations").insert(rows);
  if (eErr) throw eErr;

  console.log(`Seeded ${v.name} with ${rows.length} evaluations.`);
}

console.log("\nDone.");
