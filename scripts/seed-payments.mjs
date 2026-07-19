// Seeds default payment settings + 3 vendor payment requests to demo the B4
// gate both ways: a high-scoring vendor (passes), a low-scoring vendor (blocked
// at the performance gate), and one already remitted (SIMULATED). Re-runnable.
// Usage: node scripts/seed-payments.mjs
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

// default settings
await supabase.from("payment_settings").upsert({
  org_id: ORG_ID,
  min_performance_score: 70,
  approval_threshold_amount: 1000000,
});
console.log("Payment settings: min_performance_score=70, approval_threshold=₦1,000,000");

async function vendorId(name) {
  const { data } = await supabase
    .from("vendors")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("name", name)
    .single();
  if (!data) throw new Error(`Vendor not found: ${name} (run seed-vendors first)`);
  return data.id;
}

const sparkle = await vendorId("Sparkle Cleaning Services");
const fixit = await vendorId("FixIt Plumbing");
const secure = await vendorId("SecureGuard Ltd");

// clear prior seeded payments by invoice reference
const refs = ["INV-SPK-0007", "INV-FXP-0031", "INV-SEC-0019"];
await supabase.from("payments").delete().in("invoice_reference", refs);

const rows = [
  {
    org_id: ORG_ID,
    vendor_id: sparkle,
    invoice_reference: "INV-SPK-0007",
    amount: 450000,
    status: "pending_verification",
    performance_validated: false,
  },
  {
    org_id: ORG_ID,
    vendor_id: fixit,
    invoice_reference: "INV-FXP-0031",
    amount: 280000,
    status: "pending_verification",
    performance_validated: false,
  },
  {
    org_id: ORG_ID,
    vendor_id: secure,
    invoice_reference: "INV-SEC-0019",
    amount: 620000,
    status: "remitted",
    performance_validated: true,
    service_verified_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    approved_at: new Date(Date.now() - 86400000 * 2).toISOString(),
    remittance_reference: "SIMULATED-POC-HISTORICAL",
  },
];

const { error } = await supabase.from("payments").insert(rows);
if (error) throw error;

console.log("Seeded 3 payment requests:");
console.log("  Sparkle Cleaning (₦450,000) — pending_verification [will PASS]");
console.log("  FixIt Plumbing (₦280,000) — pending_verification [will be BLOCKED]");
console.log("  SecureGuard (₦620,000) — remitted [historical]");
