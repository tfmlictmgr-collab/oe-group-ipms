// Seeds the remaining B7 role logins (admin + tenant already exist) and marks a
// realistic portion of issued service charges as paid so collection-rate KPIs
// aren't 0% or 100%. Re-runnable.
// Usage: node scripts/seed-demo-state.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const ORG_ID = process.env.DEMO_ORG_ID;
const PASSWORD = "OEGroupDemo2026!";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Role logins (completes the B7 matrix) ──────────────────────────────────
const ROLE_USERS = [
  { email: "fm@oegroup.test", role: "facility_manager", name: "Chidi Nwosu" },
  { email: "finance@oegroup.test", role: "finance_approver", name: "Ngozi Balogun" },
  { email: "ops@oegroup.test", role: "fm_ops_staff", name: "Emeka Ade" },
  { email: "owner@oegroup.test", role: "property_owner", name: "Bola Adeyemi" },
  { email: "vendor@oegroup.test", role: "vendor", name: "Sparkle Cleaning (Vendor)" },
];

const { data: list } = await supabase.auth.admin.listUsers();

for (const u of ROLE_USERS) {
  let authUser = list?.users?.find((x) => x.email === u.email);
  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    authUser = data.user;
  }
  const { error: upErr } = await supabase.from("users").upsert({
    id: authUser.id,
    org_id: ORG_ID,
    role: u.role,
    full_name: u.name,
    email: u.email,
  });
  if (upErr) throw upErr;
  console.log(`  ${u.role.padEnd(18)} ${u.email}`);

  // Link the vendor login to the Sparkle vendor record so vendor-scoped RLS
  // (own scorecard / own pay status) resolves.
  if (u.role === "vendor") {
    await supabase
      .from("vendors")
      .update({ user_id: authUser.id })
      .eq("org_id", ORG_ID)
      .eq("name", "Sparkle Cleaning Services");
  }
}

// ── Collection state: mark ~60% of issued charges paid ─────────────────────
const { data: charges } = await supabase
  .from("service_charges")
  .select("id")
  .eq("org_id", ORG_ID)
  .eq("status", "invoiced")
  .order("created_at");

if (charges && charges.length > 0) {
  const paidCount = Math.floor(charges.length * 0.6);
  const paidIds = charges.slice(0, paidCount).map((c) => c.id);
  if (paidIds.length > 0) {
    const { error } = await supabase
      .from("service_charges")
      .update({ status: "paid" })
      .in("id", paidIds);
    if (error) throw error;
  }
  console.log(`\nMarked ${paidCount}/${charges.length} service charges as paid.`);
} else {
  console.log("\nNo invoiced service charges found — generate invoices first.");
}

console.log(`\nAll role logins use password: ${PASSWORD}`);
