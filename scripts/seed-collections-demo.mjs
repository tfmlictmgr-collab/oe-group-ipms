// Makes the Day-5 collections flow demonstrable in BOTH brand orgs.
//
// TFML and OEA were seeded with an admin and a ticket each — enough to prove
// isolation, not enough to show money moving. This adds, per brand: a finance
// approver, a tenant, a property + unit, a chart of accounts, and ONE unpaid
// service charge billed to that tenant.
//
// Idempotent: safe to re-run. It never touches the OE Group POC org, and it
// never creates a second unpaid charge for the same billing period.
//
// Usage: node scripts/seed-collections-demo.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const PASSWORD = "OEGroupDemo2026!";

// Payment gateways refuse reserved domains — Paystack answers "Invalid Email
// Address Passed" for anything on `.test`, which is what the other seeds use.
// So the demo TENANTS get addresses on the brands' real domains; staff logins
// stay on `.test`, since they only ever authenticate.
//
// Set DEMO_PAYER_EMAIL to your own inbox to receive the gateway's test receipts
// yourself — each brand gets a distinct sub-address:
//   DEMO_PAYER_EMAIL=you@gmail.com  →  you+tfml@gmail.com / you+oea@gmail.com
const PAYER_INBOX = process.env.DEMO_PAYER_EMAIL?.trim() || null;
function payerEmail(tag, fallbackDomain) {
  if (!PAYER_INBOX || !PAYER_INBOX.includes("@")) return `demo.tenant@${fallbackDomain}`;
  const [local, domain] = PAYER_INBOX.split("@");
  return `${local}+${tag}@${domain}`;
}
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BRANDS = [
  {
    orgName: "TFML — Total Facilities Management",
    finance: { email: "tfml.financeapprover@oegroup.test", name: "Chidi Nwosu (TFML Finance)" },
    tenant: { email: payerEmail("tfml", "tfmlconsultant.com"), name: "Halima Yusuf" },
    retiredTenantEmail: "tenant.tfml@oegroup.test",
    property: "Adeola Odeku Complex",
    unit: "Suite 3B",
    period: "2026 · Q3",
    amount: 285000,
  },
  {
    orgName: "OEA — Ora Egbunike & Associates",
    finance: { email: "oea.financeapprover@oegroup.test", name: "Ngozi Eze (OEA Finance)" },
    tenant: { email: payerEmail("oea", "oraegbunike.com"), name: "Segun Balogun" },
    retiredTenantEmail: "tenant.oea@oegroup.test",
    property: "Banana Island Residences",
    unit: "Villa 7",
    period: "2026 · Q3",
    amount: 640000,
  },
];

const { data: authList } = await svc.auth.admin.listUsers();

async function ensureUser(email, fullName, role, orgId) {
  let authUser = authList?.users?.find((u) => u.email === email);
  if (!authUser) {
    const { data, error } = await svc.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
    });
    if (error) throw new Error(`${email}: ${error.message}`);
    authUser = data.user;
  }
  const { error } = await svc.from("users").upsert({
    id: authUser.id, org_id: orgId, role, full_name: fullName, email,
  });
  if (error) throw new Error(`${email} profile: ${error.message}`);
  return authUser.id;
}

for (const b of BRANDS) {
  const { data: org } = await svc.from("orgs").select("id, name")
    .eq("name", b.orgName).maybeSingle();
  if (!org) { console.log(`skip — ${b.orgName} not found (run seed-brands first)`); continue; }

  // An earlier run of this script created the tenant on a `.test` address, which
  // the gateway will not accept. Move that same account rather than leaving a
  // dead one beside a new one — the unit and its invoice already point at it.
  const stale = authList?.users?.find((u) => u.email === b.retiredTenantEmail);
  if (stale && b.retiredTenantEmail !== b.tenant.email) {
    const { error } = await svc.auth.admin.updateUserById(stale.id, {
      email: b.tenant.email, email_confirm: true,
    });
    if (error) throw new Error(`moving ${b.retiredTenantEmail}: ${error.message}`);
    await svc.from("users").update({ email: b.tenant.email }).eq("id", stale.id);
    stale.email = b.tenant.email;
    console.log(`  moved ${b.retiredTenantEmail} → ${b.tenant.email}`);
  }

  const financeId = await ensureUser(b.finance.email, b.finance.name, "finance_approver", org.id);
  const tenantId = await ensureUser(b.tenant.email, b.tenant.name, "tenant", org.id);

  // The chart of accounts must exist before anything can be collected.
  await svc.rpc("ensure_default_ledger_accounts", { p_org_id: org.id });

  let { data: property } = await svc.from("properties").select("id")
    .eq("org_id", org.id).eq("name", b.property).maybeSingle();
  if (!property) {
    const { data, error } = await svc.from("properties")
      .insert({ org_id: org.id, name: b.property }).select("id").single();
    if (error) throw error;
    property = data;
  }

  let { data: unit } = await svc.from("units").select("id")
    .eq("org_id", org.id).eq("property_id", property.id).eq("label", b.unit).maybeSingle();
  if (!unit) {
    const { data, error } = await svc.from("units")
      .insert({ org_id: org.id, property_id: property.id, label: b.unit, occupant_user_id: tenantId })
      .select("id").single();
    if (error) throw error;
    unit = data;
  } else {
    await svc.from("units").update({ occupant_user_id: tenantId }).eq("id", unit.id);
  }

  // One unpaid charge for the period — re-running must not create a second, or
  // the demo shows two invoices for the same quarter.
  const { data: existing } = await svc.from("service_charges").select("id, status")
    .eq("org_id", org.id).eq("unit_id", unit.id).eq("billing_period", b.period).maybeSingle();

  if (!existing) {
    const { error } = await svc.from("service_charges").insert({
      org_id: org.id,
      unit_id: unit.id,
      billed_to_user_id: tenantId,
      property_or_unit: `${b.property} · ${b.unit}`,
      billing_period: b.period,
      amount: b.amount,
      status: "invoiced",
      due_date: "2026-09-30",
    });
    if (error) throw error;
  }

  const { data: acct } = await svc.rpc("collection_bank_account", { p_org_id: org.id });
  const { data: acctRow } = await svc.from("ledger_accounts").select("code, name")
    .eq("id", acct).maybeSingle();

  console.log(
    `${org.name}\n` +
    `  finance login : ${b.finance.email}\n` +
    `  tenant        : ${b.tenant.email} (${b.tenant.name})\n` +
    `  invoice       : ₦${b.amount.toLocaleString()} — ${b.property} · ${b.unit}, ${b.period}` +
    `${existing ? " (already present)" : ""}\n` +
    `  collects into : ${acctRow ? `${acctRow.code} ${acctRow.name}` : "NO ACCOUNT — check banking settings"}\n`
  );
}

console.log(`All logins use the password: ${PASSWORD}`);
console.log("Each org sees only its own invoice — that is org_id RLS, not UI filtering.");
