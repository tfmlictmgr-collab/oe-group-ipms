// One documented login per role, per organisation — and a sweep of the probe
// accounts that verification runs left behind.
//
// ⚠️ Why this replaces the old flat pool. Every demo account lived in the POC
// org, so "sign in as an FM" always landed in the POC whatever brand you meant
// to look at, and the operator credential was indistinguishable from a tenant
// one. That is what made the product read as a proof-of-concept with roles
// bolted on rather than a platform with organisations in it.
//
// Now each credential belongs to exactly one org and names the door it opens:
//   • the operator signs in at /login          → lands on the org launcher
//   • everyone else signs in at /o/<slug>      → lands in their own dashboard
//
// Usage: node scripts/seed-org-logins.mjs
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

// Roles worth having a standing login for, per tenant org. Deliberately not
// every role in the enum — a login nobody uses is a credential nobody rotates.
const TENANT_ROLES = [
  ["admin", "Administrator"],
  ["executive", "Managing Director"],
  ["finance_approver", "Finance Approver"],
  ["regional_manager", "Regional Manager"],
  ["facility_manager", "Manager"],
  ["fm_ops_staff", "Operations Staff"],
  ["property_owner", "Property Owner"],
  ["tenant", "Tenant"],
  ["vendor", "Vendor"],
];

// ── 1. Sweep the probe accounts ───────────────────────────────────────────
//
// Same fault class as the hierarchy nodes and the probe properties: suites whose
// end-of-run cleanup never ran because an earlier assertion threw. They surface
// as dozens of nonsense names on the People screen.
const PROBE_PATTERNS = ["probe%", "probeop.%", "probehier.%", "probereview.%", "invitee-%"];
let swept = 0;
for (const pattern of PROBE_PATTERNS) {
  const { data } = await svc.from("users").select("id, email").ilike("email", pattern);
  for (const u of data ?? []) {
    // Detach anything that would hold the row back, then remove the profile and
    // the auth account together — a profile without its auth user is a ghost
    // that can never sign in and never be cleaned up by email again.
    await svc.from("property_stakeholders").delete().eq("user_id", u.id);
    await svc.from("units").update({ occupant_user_id: null }).eq("occupant_user_id", u.id);
    await svc.from("vendors").update({ user_id: null }).eq("user_id", u.id);
    const { error } = await svc.from("users").delete().eq("id", u.id);
    if (!error) {
      await svc.auth.admin.deleteUser(u.id).catch(() => {});
      swept++;
    }
  }
}
console.log(`Swept ${swept} probe account(s).\n`);

// ── 2. Resolve the organisations ──────────────────────────────────────────
const { data: orgs, error: orgErr } = await svc
  .from("orgs")
  .select("id, name, slug, delivery_brand, is_platform_operator")
  .is("deleted_at", null)
  .order("name");
if (orgErr) { console.error(orgErr.message); process.exit(1); }

const operator = orgs.find((o) => o.is_platform_operator);
if (!operator) { console.error("No platform operator org — run migration 0088."); process.exit(1); }

const { data: authList } = await svc.auth.admin.listUsers({ perPage: 1000 });

async function ensureLogin(email, orgId, role, fullName) {
  let authUser = authList?.users?.find((u) => u.email === email);
  if (!authUser) {
    const { data, error } = await svc.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
    });
    if (error) {
      // Already exists but wasn't in the page we listed — look it up rather
      // than silently skipping, which would leave a login that cannot sign in.
      const { data: again } = await svc.auth.admin.listUsers({ perPage: 1000 });
      authUser = again?.users?.find((u) => u.email === email);
      if (!authUser) return { email, ok: false, why: error.message.slice(0, 60) };
    } else {
      authUser = data.user;
    }
  } else {
    // Reset the password so a documented credential always actually works.
    await svc.auth.admin.updateUserById(authUser.id, { password: PASSWORD });
  }

  const { error } = await svc.from("users").upsert({
    id: authUser.id, org_id: orgId, role, full_name: fullName, email,
  });
  return { email, ok: !error, why: error?.message.slice(0, 60) };
}

// ── 3. The operator's own administrator ───────────────────────────────────
//
// The ONLY account that should reach /login and see the launcher.
const rows = [];
rows.push({
  org: operator.name, slug: operator.slug, role: "admin", door: "/login",
  ...(await ensureLogin("platform@oegroup.test", operator.id, "admin", "OE Group Platform Admin")),
});

// ── 4. One login per role, per tenant org ─────────────────────────────────
for (const org of orgs.filter((o) => !o.is_platform_operator)) {
  for (const [role, title] of TENANT_ROLES) {
    // `oea.finance@…` reads as "the OEA finance login" at a glance, which is the
    // whole point — the email itself says which door it belongs at.
    const email = `${org.slug}.${role.replace(/_/g, "")}@oegroup.test`;
    rows.push({
      org: org.name, slug: org.slug, role, door: `/o/${org.slug}`,
      ...(await ensureLogin(email, org.id, role, `${org.delivery_brand} ${title}`)),
    });
  }
}

// ── 5. Report ─────────────────────────────────────────────────────────────
const failed = rows.filter((r) => !r.ok);
let currentOrg = null;
for (const r of rows) {
  if (r.org !== currentOrg) {
    currentOrg = r.org;
    console.log(`\n${r.org}  —  sign in at ${r.door}`);
  }
  console.log(`  ${r.role.padEnd(18)} ${r.email}${r.ok ? "" : `   ✗ ${r.why}`}`);
}

console.log(`\nPassword for every account above: ${PASSWORD}`);
console.log(
  failed.length === 0
    ? `\n${rows.length} login(s) ready.`
    : `\n${failed.length} of ${rows.length} FAILED.`
);
process.exit(failed.length === 0 ? 0 : 1);
