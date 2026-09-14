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
  { email: "oe-group-foundation-poc.facilitymanager@oegroup.test", role: "facility_manager", name: "Abdul Owo" },
  { email: "oe-group-foundation-poc.financeapprover@oegroup.test", role: "finance_approver", name: "Oke Anderson" },
  { email: "oe-group-foundation-poc.fmopsstaff@oegroup.test", role: "fm_ops_staff", name: "Emeka Ade" },
  { email: "oe-group-foundation-poc.propertyowner@oegroup.test", role: "property_owner", name: "Bola Adeyemi" },
  { email: "oe-group-foundation-poc.vendor@oegroup.test", role: "vendor", name: "Sparkle Cleaning (Vendor)" },
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
//
// ⚠️ `amount_paid` is set with the status, and that was the whole defect here.
// This wrote `status: 'paid'` and NOTHING ELSE, so on every seeded world a
// charge read "paid" while `amount_paid` stayed 0. Three screens then disagreed
// about the same money: Statements showed a paid invoice, Client Funds →
// Collections showed ₦0.00 collected, and a landlord's own statement showed
// nothing received — because every one of those reads the AMOUNT and only this
// line touched the status. Measured on staging before the fix: 30 charges
// `paid`, all 30 with `amount_paid = 0`.
//
// ⚠️ And it is still fiction, deliberately labelled as such. A genuinely paid
// service charge is one `record_collection` posted, which needs a payment intent
// verified at the gateway — so the money would appear in the ledger, in the
// segregation position and on the bank reconciliation. This does none of that:
// it makes the REGISTER internally consistent so the demo does not contradict
// itself, and leaves the books honestly empty. Anything else would put money in
// the ledger that no bank statement can ever match, which is precisely what
// daily reconciliation exists to catch.
const { data: charges } = await supabase
  .from("service_charges")
  .select("id, amount")
  .eq("org_id", ORG_ID)
  .eq("status", "invoiced")
  .order("created_at");

if (charges && charges.length > 0) {
  const paidCount = Math.floor(charges.length * 0.6);
  const toPay = charges.slice(0, paidCount);
  for (const c of toPay) {
    const { error } = await supabase
      .from("service_charges")
      .update({ status: "paid", amount_paid: c.amount })
      .eq("id", c.id);
    if (error) throw error;
  }
  console.log(
    `\nMarked ${paidCount}/${charges.length} service charges as paid, ` +
    `with amount_paid set to match.` +
    `\n  NOTE: this is register-level only — no ledger posting, so Client Funds` +
    `\n  stays empty. Collect through the gateway to see money in the books.`
  );
} else {
  console.log("\nNo invoiced service charges found — generate invoices first.");
}

console.log(`\nAll role logins use password: ${PASSWORD}`);
