// Give TFML and OEA a login for every role, so each branded portal can be
// demonstrated end to end without borrowing the POC org's accounts.
//
// seed-brand-demo-content.mjs gave each brand a property, vendors, requests and
// an FM/finance login. That is enough to show a dashboard and not enough to walk
// a journey: there was no tenant to raise a request, no vendor to receive it, no
// ops staff to dispatch to, no owner to see the portfolio. Anyone demonstrating
// the golden path on tfmlportal.com had to switch to the POC org halfway
// through, which is precisely the thing brand isolation is supposed to make
// unnecessary.
//
// Additive and idempotent. Nothing is truncated; every account and every
// supporting row is checked for before it is written, so a second run tops up
// rather than duplicating. Every insert's `.error` is read — this codebase has
// been bitten three times by seeds that discarded it and reported success
// (seed-org-logins.mjs's own comment, the approval-chain teardown in b373b01,
// and seed.mjs silently seeding zero tickets for months).
//
// Usage: node scripts/seed-brand-roles.mjs
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
const PASSWORD = "OEGroupDemo2026!";

// ⚠️ `current_user_role()` reads the `users` row, not the JWT (0001), but the
// brand middleware and the org claim read `app_metadata`. Both are written, and
// app_metadata is refreshed on every run so a reused auth user can never drift
// from the profile beside it.
async function ensureUser({ email, orgId, brand, role, fullName, approvalTier = null }) {
  const { data: list, error: listErr } = await svc.auth.admin.listUsers();
  if (listErr) throw new Error(`listUsers: ${listErr.message}`);

  const appMetadata = { org_id: orgId, delivery_brand: brand, role };
  let u = list.users.find((x) => x.email === email);
  let created = false;
  if (!u) {
    const { data, error } = await svc.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true, app_metadata: appMetadata,
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    u = data.user;
    created = true;
  } else {
    const { error } = await svc.auth.admin.updateUserById(u.id, { app_metadata: appMetadata });
    if (error) throw new Error(`updateUser ${email}: ${error.message}`);
  }

  // `approval_tier` is constrained: a payment_approver MUST carry 1-3 and every
  // other role MUST carry null (users_approval_tier_check, 0151).
  const { error: upErr } = await svc.from("users").upsert(
    { id: u.id, org_id: orgId, role, full_name: fullName, email, approval_tier: approvalTier },
    { onConflict: "id" }
  );
  if (upErr) throw new Error(`users upsert ${email}: ${upErr.message}`);

  return { id: u.id, created };
}

const BRANDS = [
  {
    label: "TFML", brand: "TFML", slug: "tfml",
    property: "Marina Business Park",
    vendor: "Apex Facilities Cleaning",
    lettings: false,          // facilities brand — no tenancy/rent journey
    people: {
      fm_ops_staff:           ["tfml.ops@oegroup.test",           "Musa Danjuma (TFML)"],
      property_owner:         ["tfml.owner@oegroup.test",         "Adaeze Obi (TFML)"],
      tenant:                 ["tfml.tenant@oegroup.test",        "Segun Adeyemi (TFML)"],
      vendor:                 ["tfml.vendor@oegroup.test",        "Apex Facilities Cleaning (Vendor)"],
      regional_manager:       ["tfml.regional@oegroup.test",      "Hauwa Bello (TFML)"],
      executive:              ["tfml.executive@oegroup.test",     "Olumide Falana (TFML MD)"],
      viewer:                 ["tfml.viewer@oegroup.test",        "Ngozi Eze (TFML)"],
      payment_approver:       ["tfml.approver@oegroup.test",      "Bashir Lawal (TFML)"],
      payment_audit_approver: ["tfml.auditapprover@oegroup.test", "Chioma Nnaji (TFML)"],
    },
  },
  {
    label: "OEA", brand: "OEA", slug: "oea",
    property: "Parkview Terraces",
    vendor: "GreenLeaf Landscaping",
    lettings: true,           // property brand — gets a tenancy and a rent demand
    people: {
      fm_ops_staff:           ["oea.ops@oegroup.test",           "Yusuf Garba (OEA)"],
      property_owner:         ["oea.owner@oegroup.test",         "Ifeoma Duru (OEA)"],
      tenant:                 ["oea.tenant@oegroup.test",        "Kelechi Umeh (OEA)"],
      vendor:                 ["oea.vendor@oegroup.test",        "GreenLeaf Landscaping (Vendor)"],
      regional_manager:       ["oea.regional@oegroup.test",      "Aisha Sani (OEA)"],
      executive:              ["oea.executive@oegroup.test",     "Emeka Ilo (OEA Managing Partner)"],
      viewer:                 ["oea.viewer@oegroup.test",        "Blessing Okoro (OEA)"],
      payment_approver:       ["oea.approver@oegroup.test",      "Tunde Salami (OEA)"],
      payment_audit_approver: ["oea.auditapprover@oegroup.test", "Grace Nwankwo (OEA)"],
    },
  },
];

for (const b of BRANDS) {
  const { data: orgs, error: orgErr } = await svc
    .from("orgs").select("id, name").eq("slug", b.slug).is("deleted_at", null);
  if (orgErr) throw new Error(`orgs ${b.slug}: ${orgErr.message}`);
  if (orgs?.length !== 1) {
    console.error(`Skipping ${b.label}: expected 1 org with slug=${b.slug}, found ${orgs?.length ?? 0}`);
    continue;
  }
  const orgId = orgs[0].id;
  console.log(`\n── ${orgs[0].name} ──`);

  // ── The accounts ───────────────────────────────────────────────────────
  const ids = {};
  for (const [role, [email, fullName]] of Object.entries(b.people)) {
    const { id, created } = await ensureUser({
      email, orgId, brand: b.brand, role, fullName,
      // Tier 2 clears up to ₦1,000,000 — enough to approve the seeded vendor
      // invoices without being the tier that needs an executive beside it.
      approvalTier: role === "payment_approver" ? 2 : null,
    });
    ids[role] = id;
    console.log(`  ${created ? "created" : "exists "}  ${role.padEnd(23)} ${email}`);
  }

  const { data: prop } = await svc.from("properties")
    .select("id, site_node_id").eq("org_id", orgId).eq("name", b.property).maybeSingle();
  if (!prop) { console.error(`  ! property "${b.property}" not found — run seed-brand-demo-content.mjs first`); continue; }

  // ── Property owner sees their portfolio ────────────────────────────────
  await ensureStakeholder(orgId, prop.id, ids.property_owner, "owner");

  // ── Regional manager ───────────────────────────────────────────────────
  //
  // Scope resolves through `current_user_property_ids()` (0067), which unions
  // direct property assignments with everything beneath an assigned NODE. These
  // properties are unfiled (`site_node_id is null`), so a node assignment would
  // resolve to nothing — the direct assignment is what actually gives them
  // something to manage. Filing the property under a region is a judgement about
  // the client's real structure and belongs to whoever knows it, not to a seed.
  await ensureStakeholder(orgId, prop.id, ids.regional_manager, "manager");

  // ── The vendor login ───────────────────────────────────────────────────
  const { data: vendor } = await svc.from("vendors")
    .select("id, user_id").eq("org_id", orgId).eq("name", b.vendor).maybeSingle();
  if (!vendor) {
    console.error(`  ! vendor "${b.vendor}" not found — skipping vendor link`);
  } else {
    // vendor_users is the real permission surface since 0163; vendors.user_id
    // is the legacy single-login FK that `raise_work_order`'s notify still
    // reads, so both are set rather than one.
    const { data: link } = await svc.from("vendor_users")
      .select("id").eq("vendor_id", vendor.id).eq("user_id", ids.vendor).maybeSingle();
    if (!link) {
      const { error } = await svc.from("vendor_users").insert({
        org_id: orgId, vendor_id: vendor.id, user_id: ids.vendor, is_owner: true,
        capabilities: ["manage_users", "manage_profile", "manage_work", "manage_contracts"],
      });
      if (error) throw new Error(`vendor_users (${b.label}): ${error.message}`);
    }
    if (!vendor.user_id) {
      const { error } = await svc.from("vendors").update({ user_id: ids.vendor }).eq("id", vendor.id);
      if (error) throw new Error(`vendors.user_id (${b.label}): ${error.message}`);
    }
    console.log(`  linked   vendor login -> ${b.vendor}`);
  }

  // ── The tenant occupies a unit ─────────────────────────────────────────
  //
  // Without this the tenant has no property, so their requests are unfiled and
  // the FM cannot see them (tickets.triage_unassigned is off for FMs by B7).
  const { data: unit } = await svc.from("units")
    .select("id, label, occupant_user_id").eq("property_id", prop.id)
    .order("label").limit(1).maybeSingle();
  if (!unit) {
    console.error("  ! no units on that property — skipping tenancy");
  } else {
    if (unit.occupant_user_id !== ids.tenant) {
      const { error } = await svc.from("units")
        .update({ occupant_user_id: ids.tenant }).eq("id", unit.id);
      if (error) throw new Error(`units.occupant (${b.label}): ${error.message}`);
    }
    console.log(`  occupied ${unit.label} by the tenant`);

    // ── A tenancy and one rent demand, for the lettings brand only ───────
    if (b.lettings) {
      const { data: existing } = await svc.from("leases")
        .select("id").eq("unit_id", unit.id).eq("tenant_user_id", ids.tenant)
        .is("deleted_at", null).maybeSingle();

      let leaseId = existing?.id ?? null;
      if (!leaseId) {
        const start = new Date(); start.setMonth(start.getMonth() - 3);
        const end = new Date(start); end.setFullYear(end.getFullYear() + 1);
        const iso = (d) => d.toISOString().slice(0, 10);
        const { data: lease, error } = await svc.from("leases").insert({
          org_id: orgId, property_id: prop.id, unit_id: unit.id,
          tenant_user_id: ids.tenant,
          start_date: iso(start), end_date: iso(end),
          rent_amount: 6_000_000, rent_frequency: "annual", status: "active",
        }).select("id, start_date, end_date").single();
        if (error) throw new Error(`leases (${b.label}): ${error.message}`);
        leaseId = lease.id;
        console.log(`  tenancy  ${lease.start_date} → ${lease.end_date}, ₦6,000,000/yr`);

        // One demand, so My Rent has something real rather than an empty state.
        // raise_rent_charge is the ONLY writer (0091) — the fee snapshot has one
        // code path and a hand-written rent_charges row would bypass it.
        const { error: rcErr } = await svc.rpc("raise_rent_charge", {
          p_lease_id: leaseId,
          p_period_start: lease.start_date,
          p_period_end: lease.end_date,
        });
        if (rcErr) console.error(`  ! rent demand not raised: ${rcErr.message}`);
        else console.log("  demand   raised for the current period");
      } else {
        console.log("  tenancy  already exists");
      }
    }
  }
}

async function ensureStakeholder(orgId, propertyId, userId, relation) {
  const { data: existing } = await svc.from("property_stakeholders")
    .select("id").eq("property_id", propertyId).eq("user_id", userId)
    .eq("relation", relation).maybeSingle();
  if (existing) return;
  const { error } = await svc.from("property_stakeholders")
    .insert({ org_id: orgId, property_id: propertyId, user_id: userId, relation });
  if (error) throw new Error(`property_stakeholders ${relation}: ${error.message}`);
}

console.log(`\n✅ Brand role logins ready. Password for all: ${PASSWORD}`);
