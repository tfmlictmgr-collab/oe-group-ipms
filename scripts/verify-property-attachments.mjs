// A property filed without its people can be given them later.
//
// The scenario this exists for: someone onboards a property in a hurry and
// skips the manager, the landlord, the contractor or the occupant. Nothing
// about that is exceptional — it is the normal case, because the FM/PM filing
// a building often does not yet know who will manage it. So every attachment
// must be reachable AFTER the fact, by the people who would plausibly do it,
// and not only through the onboarding form.
//
// The claims that matter:
//   • an ADMIN can attach a manager, a landlord, a contractor and an occupant
//     to a property that has none of them
//   • an FM/PM can do the same on a property they hold — 0191 split the
//     property-level write away from hierarchy.write precisely so that a
//     property-level attachment is not an admin-only act
//   • each attachment is DETACHABLE again, since a wrong attachment is how
//     these get noticed
//   • a landlord attachment does not quietly hand out request visibility
//     (decision 19 / 0184) — attaching an owner is not attaching a manager
//   • every attachment lands on the audit trail, because "who gave this
//     contractor access to this building" is an auditor's question
//
// Fixtures are resolved by ROLE within the org and restricted to fixture
// addresses — never a hardcoded email (the seeding convention has legitimately
// changed twice) and never a real staff account (see the note below).
//
// Usage: node scripts/verify-property-attachments.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { liveOrgForBrand } from "./lib/org-lookup.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const skip = (m) => console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const TAG = `PROBEATT-${S}`;

// ── Resolve the org and the people ─────────────────────────────────────────
const { org, error: orgErr, candidates } = await liveOrgForBrand(svc, "OEA");
if (orgErr) { console.error(orgErr, candidates?.map((c) => c.name)); process.exit(1); }

console.log("Attaching people to a property that was filed without them\n");

// ⚠️ A missing fixture SKIPS the checks that need it; it does not kill the run.
// The last journal entry records four suites that died on a fixture lookup
// before stating a single claim, and read as "the code is broken" when the
// seeding had merely moved. A role can also be legitimately absent mid-flight:
// on staging, OEA's landlord was deactivated and their replacement invitation
// is still unaccepted — real work in progress, not a defect for this suite to
// fail over.
//
// ⚠️ Resolve to a FIXTURE address only. Staging now carries real OEA staff on
// their own addresses (an onboarding in progress), and fixtureUser() resolves
// by role — so a bare lookup handed this suite `odijeolive@gmail.com`, a real
// person, whose account it then tried to sign into with the shared demo
// password. It failed, as it should. **A suite must never attempt to
// authenticate as a real account**: the attempt is wrong even when it is
// refused, and it puts failed sign-ins on a colleague's account.
const FIXTURE_DOMAIN = "@oegroup.test";
let admin, fmpm, landlord, tenant, vendorRow;
const absent = [];
const need = async (role, fallback = null) => {
  for (const r of [role, fallback].filter(Boolean)) {
    const { data } = await svc.from("users")
      .select("id, email, role")
      .eq("org_id", org.id).eq("role", r).is("deactivated_at", null)
      .ilike("email", `%${FIXTURE_DOMAIN}`)
      .order("created_at", { ascending: true });
    if (data?.length) return data[0];
  }
  absent.push(role);
  return null;
};

admin = await need("admin");
landlord = await need("property_owner");
tenant = await need("tenant");
// OEA staffs property_manager after 0182; fall back to facility_manager for a
// world seeded before the split.
fmpm = await need("property_manager", "facility_manager");

if (!admin || !fmpm) {
  console.error(
    `Cannot run: this org has no live ${!admin ? "admin" : "FM/PM"}.\n` +
    "  Seed one with: node scripts/seed-brand-roles.mjs"
  );
  process.exit(1);
}
if (absent.length) {
  console.log(`  \x1b[33mNOTE\x1b[0m no live ${absent.join(", ")} in this org — checks needing them are skipped\n`);
}

const { data: vendors } = await svc
  .from("vendors").select("id, name").eq("org_id", org.id).limit(1);
vendorRow = vendors?.[0];

// ── A property with nobody attached ────────────────────────────────────────
async function freshProperty(name) {
  const { data, error } = await svc.from("properties")
    .insert({ org_id: org.id, name, property_type: "residential" })
    .select("id").single();
  if (error) throw new Error(`could not create a probe property: ${error.message}`);
  return data.id;
}
const madeProps = [];
async function cleanup() {
  for (const p of madeProps) {
    await svc.from("vendor_properties").delete().eq("property_id", p);
    await svc.from("property_stakeholders").delete().eq("property_id", p);
    await svc.from("units").delete().eq("property_id", p);
    await svc.from("properties").delete().eq("id", p);
  }
  // Anything a previous crashed run left behind.
  const { data: stale } = await svc
    .from("properties").select("id").like("name", "PROBEATT-%");
  for (const p of stale ?? []) {
    if (madeProps.includes(p.id)) continue;
    await svc.from("vendor_properties").delete().eq("property_id", p.id);
    await svc.from("property_stakeholders").delete().eq("property_id", p.id);
    await svc.from("units").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
}
await cleanup();

// ══ A. The administrator ═══════════════════════════════════════════════════
console.log("A. An administrator attaches all four, after the fact");
{
  const propId = await freshProperty(`${TAG}-admin`);
  madeProps.push(propId);
  const c = await login(admin.email);

  // Manager
  {
    const { error } = await c.from("property_stakeholders")
      .insert({ org_id: org.id, property_id: propId, user_id: fmpm.id, relation: "manager" });
    error ? bad(`admin could not attach a manager: ${error.message}`)
          : ok(`a ${fmpm.role} was attached as manager to a property with none`);
  }
  // Landlord
  if (!landlord) {
    skip("no live landlord in this org to attach");
  } else {
    const { error } = await c.from("property_stakeholders")
      .insert({ org_id: org.id, property_id: propId, user_id: landlord.id, relation: "owner" });
    error ? bad(`admin could not attach a landlord: ${error.message}`)
          : ok("a landlord was attached as owner");
  }
  // Contractor
  if (!vendorRow) {
    skip("no vendor exists in this org to attach");
  } else {
    const { error } = await c.from("vendor_properties")
      .insert({ org_id: org.id, property_id: propId, vendor_id: vendorRow.id });
    error ? bad(`admin could not attach a contractor: ${error.message}`)
          : ok(`contractor "${vendorRow.name}" was attached to the property`);
  }
  // Occupant — a tenant occupies a UNIT, not a building, so this is the unit's
  // own occupant field rather than a fifth stakeholder relation.
  {
    const { data: unit, error: uErr } = await c.from("units")
      .insert({ org_id: org.id, property_id: propId, label: "Flat 1", apportionment_factor: 50 })
      .select("id").single();
    if (uErr) { bad(`admin could not add a unit: ${uErr.message}`); }
    else if (!tenant) { skip("no live tenant in this org to attach as occupant"); }
    else {
      const { error } = await c.from("units")
        .update({ occupant_user_id: tenant.id }).eq("id", unit.id);
      error ? bad(`admin could not attach an occupant: ${error.message}`)
            : ok("an occupant was attached to a unit that was let standing empty");
    }
  }

  // ── Detach again ────────────────────────────────────────────────────────
  // Detaching the MANAGER rather than the landlord, so this claim still holds
  // in a world where no landlord exists to have been attached above.
  {
    const { error } = await c.from("property_stakeholders")
      .delete().eq("property_id", propId).eq("user_id", fmpm.id).eq("relation", "manager");
    const { data: left } = await c.from("property_stakeholders")
      .select("user_id").eq("property_id", propId).eq("user_id", fmpm.id);
    !error && (left ?? []).length === 0
      ? ok("…and a wrong attachment can be taken off again")
      : bad("AN ATTACHMENT COULD NOT BE REMOVED");
  }
  await c.auth.signOut();
}

// ══ B. The FM/PM, on a property they hold ══════════════════════════════════
// 0191's whole point: deciding who is attached to a building is the same
// authority as editing the building's record, not a larger one.
console.log("\nB. An FM/PM attaches on a property they hold (0191)");
{
  const propId = await freshProperty(`${TAG}-fmpm`);
  madeProps.push(propId);
  // They hold it: attached as manager by the service role, as onboarding would.
  await svc.from("property_stakeholders")
    .insert({ org_id: org.id, property_id: propId, user_id: fmpm.id, relation: "manager" });

  const c = await login(fmpm.email);
  if (!landlord) {
    skip("no live landlord in this org for an FM/PM to attach");
  } else {
    const { error } = await c.from("property_stakeholders")
      .insert({ org_id: org.id, property_id: propId, user_id: landlord.id, relation: "owner" });
    error ? bad(`a ${fmpm.role} could not attach a landlord: ${error.message}`)
          : ok(`a ${fmpm.role} attached a landlord without needing an administrator`);
  }
  if (!vendorRow) {
    skip("no vendor exists in this org to attach");
  } else {
    const { error } = await c.from("vendor_properties")
      .insert({ org_id: org.id, property_id: propId, vendor_id: vendorRow.id });
    error ? bad(`a ${fmpm.role} could not attach a contractor: ${error.message}`)
          : ok(`a ${fmpm.role} attached a contractor (0183 gave them this policy)`);
  }
  await c.auth.signOut();
}

// ══ C. Attaching a landlord is not attaching a manager ═════════════════════
// Decision 19 / 0184: a landlord sees their own payments and statements, and
// only the requests they raised themselves. If attaching an owner also handed
// out the operational queue, this whole feature would be a data leak.
console.log("\nC. Attaching a landlord does not hand out the request queue");
if (!landlord) {
  skip("no live landlord in this org to sign in as");
} else {
  const propId = madeProps[1];
  const c = await login(landlord.email);
  const { data: tickets, error } = await c
    .from("tickets").select("id").eq("property_id", propId);
  if (error) {
    ok("a landlord is refused the request queue on a property they own");
  } else {
    (tickets ?? []).length === 0
      ? ok("a landlord attached as owner sees no requests on that property")
      : bad(`A LANDLORD SEES ${tickets.length} REQUEST(S) ON A PROPERTY THEY MERELY OWN`);
  }
  await c.auth.signOut();
}

// ══ D. The audit trail ═════════════════════════════════════════════════════
console.log("\nD. Every attachment is on the audit trail");
{
  const { data: rows } = await svc
    .from("audit_log").select("action, created_at")
    .in("action", ["property_stakeholder.write", "vendor_property.write"])
    .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

  const kinds = new Set((rows ?? []).map((r) => r.action));
  kinds.has("vendor_property.write")
    ? ok("attaching a contractor was audited (vendor_property.write)")
    : (vendorRow ? bad("A CONTRACTOR ATTACHMENT WAS NOT AUDITED")
                 : skip("no contractor was attached, so nothing to audit"));

  // property_stakeholders' audit action name is whatever 0008 registered; if
  // this suite cannot find it, say so rather than passing quietly.
  const { data: anyStake } = await svc
    .from("audit_log").select("action")
    .ilike("action", "%stakeholder%")
    .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .limit(1);
  (anyStake ?? []).length > 0
    ? ok("attaching a manager/landlord was audited")
    : bad("NO STAKEHOLDER ATTACHMENT APPEARS ON THE AUDIT TRAIL");

  // Naming the occupant of a unit is an access grant too (0009 makes it what
  // lets a tenant read that unit's statements), and was as silent as the rest
  // until 0193.
  const { data: occ } = await svc
    .from("audit_log").select("action")
    .eq("action", "unit.occupant_change")
    .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .limit(1);
  (occ ?? []).length > 0
    ? ok("naming a unit's occupant was audited (0193)")
    : bad("AN OCCUPANT WAS ATTACHED WITH NO AUDIT ENTRY");
}

await cleanup();
console.log("\n(cleaned up)\n");

if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — a property filed without its people can be given them later.");
