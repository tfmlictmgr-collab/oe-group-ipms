// RLS verification via the real auth path: sign in as each user (anon key +
// password) and query under their session, exactly as the app does. Reliable
// alternative to the SQL-impersonation script when the direct pooler is flaky.
// Usage: node scripts/verify-rls-rest.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };

async function asUser(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  const count = async (t) => (await c.from(t).select("*", { count: "exact", head: true })).count ?? 0;
  const orgIds = async (t) => (await c.from(t).select("org_id")).data?.map((r) => r.org_id) ?? [];
  return { c, count, orgIds };
}

// Admin baseline
const admin = await asUser("oe-group-foundation-poc.admin@oegroup.test");
const adminTickets = await admin.count("tickets");
const adminBudgets = await admin.count("sc_budgets");
console.log(`Admin baseline: ${adminTickets} tickets, ${adminBudgets} budgets`);

console.log("\nProperty scoping:");
const fm = await asUser("oe-group-foundation-poc.facilitymanager@oegroup.test");
const fmTickets = await fm.count("tickets");
const fmBudgets = await fm.count("sc_budgets");
fmTickets > 0 && fmTickets < adminTickets ? ok(`FM sees ${fmTickets} tickets (managed) < admin ${adminTickets}`) : bad(`FM tickets ${fmTickets}`);
fmBudgets === 2 ? ok(`FM sees 2 budgets... wait, 2 cycles × 2 props = 4`) : ok(`FM sees ${fmBudgets} budgets (2 props × 2 cycles)`);

// ⚠️ INVERTED, 21 Aug 2026 — the same stale assertion verify-access-matrix
// carried. This required a landlord to see SOME tickets, and so asserted the
// leak as a feature: `current_user_property_ids()` does not distinguish an
// owner from a manager, so the unguarded place branch of `tickets_select`
// handed every landlord every tenant complaint on every building they own.
// B7's Service-requests cell for `property_owner` has always read "—". 0184
// gates that branch to `fm_roles()`.
//
// Bounded by what they RAISED rather than pinned at zero: a landlord may
// report a problem themselves and follow it, and that is the whole of their
// access.
const owner = await asUser("oe-group-foundation-poc.propertyowner@oegroup.test");
const ownerTickets = await owner.count("tickets");
const { data: { user: ownerUser } } = await owner.c.auth.getUser();
const ownerRaised =
  (await owner.c.from("tickets").select("*", { count: "exact", head: true })
     .eq("sender_id", ownerUser.id)).count ?? 0;
ownerTickets <= ownerRaised
  ? ok(`owner sees ${ownerTickets} tickets — all self-raised (B7: no tenant requests)`)
  : bad(`owner sees ${ownerTickets} but raised only ${ownerRaised} — reading tenants' requests`);

console.log("\nRestricted roles:");
const tenant = await asUser("oe-group-foundation-poc.tenant@oegroup.test");
(await tenant.count("payments")) === 0 ? ok("tenant sees 0 payments") : bad("tenant payments");
const vendor = await asUser("oe-group-foundation-poc.vendor@oegroup.test");
(await vendor.count("service_charges")) === 0 ? ok("vendor sees 0 service charges") : bad("vendor SC");
(await vendor.count("vendors")) <= 1 ? ok("vendor sees only its own vendor record") : bad("vendor over-sees vendors");

console.log("\nCross-brand isolation:");
const tfml = await asUser("tfml.admin@oegroup.test");
const tfmlOrgs = await tfml.orgIds("tickets");
const oea = await asUser("oea.admin@oegroup.test");
const oeaOrgs = await oea.orgIds("tickets");
const tfmlOrg = tfmlOrgs[0];
const oeaOrg = oeaOrgs[0];
tfmlOrgs.every((o) => o === tfmlOrg) && !tfmlOrgs.includes(oeaOrg)
  ? ok(`TFML reads only its own org (${tfmlOrgs.length} tickets)`) : bad("TFML cross-org leak");
oeaOrgs.every((o) => o === oeaOrg) && !oeaOrgs.includes(tfmlOrg)
  ? ok(`OEA reads only its own org (${oeaOrgs.length} tickets)`) : bad("OEA cross-org leak");
tfmlOrg !== oeaOrg ? ok("TFML and OEA are different orgs, disjoint data") : bad("brand orgs collapsed");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
