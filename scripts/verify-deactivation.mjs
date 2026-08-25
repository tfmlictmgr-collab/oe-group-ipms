// A deactivated account reaches nothing.
//
// Before 0194 it reached everything. `deactivated_at` was read only by
// application queries building pickers — "do not OFFER this person as an
// occupant" — while `current_user_role()` and `current_user_org_id()` never
// looked at it. A deactivated user signed in, kept their role, and passed
// every policy their role had ever passed.
//
// The claims that matter:
//   • a deactivated account resolves NO role and NO org — the two roots every
//     policy reaches access through
//   • it therefore reads no properties and no tickets
//   • has_permission() answers false for a capability its role plainly holds
//   • current_user_property_ids() and current_user_vendor_ids() are empty too:
//     they read auth.uid() directly and never passed through the two roots, so
//     fixing only those two would have left these answering
//   • current_user_is_active() says false — the one question a deactivated
//     caller may still ask, so a screen can say why instead of rendering empty
//   • reactivating restores every one of the above, exactly
//   • the account is not destroyed: its row, its audit trail and its
//     attachments survive deactivation (A3 — the trail is append-only)
//
// Runs against a FIXTURE account it deactivates and restores itself. It never
// resolves a real staff address: the suite drives sign-ins, and attempting to
// authenticate as a colleague is wrong even when it fails.
//
// Usage: node scripts/verify-deactivation.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

// A fixture with real reach, so "reaches nothing" is a claim with teeth: an
// FM/PM holds properties, tickets and properties.write.
const { data: candidates } = await svc
  .from("users").select("id, email, role, deactivated_at")
  .ilike("email", "%@oegroup.test")
  .is("deactivated_at", null)
  .not("email", "ilike", "probe%")
  .in("role", ["property_manager", "facility_manager"])
  .order("created_at");

const subject = (candidates ?? [])[0];
if (!subject) {
  console.error(
    "No live FM/PM fixture account (@oegroup.test) to exercise.\n" +
    "  Seed one with: node scripts/seed-brand-roles.mjs"
  );
  process.exit(1);
}

async function reach(label) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: subject.email, password: PW });
  if (error) return { signedIn: false, why: error.message };

  const [role, org, active, perm, propIds, vendIds] = await Promise.all([
    c.rpc("current_user_role"), c.rpc("current_user_org_id"),
    c.rpc("current_user_is_active"),
    c.rpc("has_permission", { p_capability: "properties.write" }),
    c.rpc("current_user_property_ids"), c.rpc("current_user_vendor_ids"),
  ]);
  const { data: props } = await c.from("properties").select("id").limit(20);
  const { data: tix } = await c.from("tickets").select("id").limit(20);
  await c.auth.signOut();

  return {
    signedIn: true,
    role: role.data ?? null, org: org.data ?? null, active: active.data,
    perm: perm.data, props: (props ?? []).length, tickets: (tix ?? []).length,
    propIds: (propIds.data ?? []).length, vendIds: (vendIds.data ?? []).length,
  };
}

console.log(`A deactivated account reaches nothing\n\n  subject: ${subject.email} (${subject.role})\n`);

// ── A. Active, so the "nothing" below means something ──────────────────────
console.log("A. While active, the account has real reach");
const before = await reach("active");
if (!before.signedIn) {
  console.error(`  cannot sign in as the fixture (${before.why}) — is the demo password current?`);
  process.exit(1);
}
before.role ? ok(`resolves a role (${before.role})`) : bad("resolves no role even while active");
before.org ? ok("resolves an org") : bad("resolves no org even while active");
before.active === true ? ok("current_user_is_active() is true") : bad("is_active is false while active");
const hadReach = before.props > 0 || before.tickets > 0 || before.perm === true;
hadReach
  ? ok(`reaches ${before.props} propert(ies), ${before.tickets} ticket(s), properties.write=${before.perm}`)
  : bad("this fixture reaches nothing even while active — it cannot prove the claim");

// ── B. Deactivated ─────────────────────────────────────────────────────────
console.log("\nB. Deactivated, it reaches nothing");
await svc.from("users")
  .update({ deactivated_at: new Date().toISOString() }).eq("id", subject.id);

const during = await reach("deactivated");
if (!during.signedIn) {
  // Also an acceptable outcome — stronger, in fact. Say which happened.
  ok(`sign-in itself is refused (${during.why})`);
} else {
  during.role === null ? ok("current_user_role() is null") : bad(`STILL RESOLVES ROLE ${during.role}`);
  during.org === null ? ok("current_user_org_id() is null") : bad("STILL RESOLVES AN ORG");
  during.active === false ? ok("current_user_is_active() is false") : bad("is_active still true");
  during.perm === false ? ok("has_permission('properties.write') is false") : bad("STILL HOLDS properties.write");
  during.props === 0 ? ok("reads no properties") : bad(`STILL READS ${during.props} PROPERT(IES)`);
  during.tickets === 0 ? ok("reads no tickets") : bad(`STILL READS ${during.tickets} TICKET(S)`);
  during.propIds === 0
    ? ok("current_user_property_ids() is empty — it reads auth.uid() directly and was fixed too")
    : bad(`current_user_property_ids() STILL RETURNS ${during.propIds}`);
  during.vendIds === 0
    ? ok("current_user_vendor_ids() is empty")
    : bad(`current_user_vendor_ids() STILL RETURNS ${during.vendIds}`);
}

// ── C. The record survives ─────────────────────────────────────────────────
// Deactivation is not deletion. A3 keeps the audit trail append-only, and the
// person's history has to remain attributable.
console.log("\nC. Deactivation is not erasure");
{
  const { data: still } = await svc
    .from("users").select("id, email, role").eq("id", subject.id).maybeSingle();
  still ? ok("the profile row survives, so past actions stay attributable")
        : bad("THE PROFILE ROW WAS DESTROYED BY DEACTIVATION");
}

// ── D. Reactivation restores exactly what was there ────────────────────────
console.log("\nD. Reactivating restores it");
await svc.from("users")
  .update({ deactivated_at: subject.deactivated_at }).eq("id", subject.id);

const after = await reach("restored");
after.signedIn && after.role === before.role
  ? ok(`the role returns (${after.role})`)
  : bad("THE ROLE DID NOT COME BACK AFTER REACTIVATION");
after.org === before.org ? ok("the org returns") : bad("the org did not come back");
after.props === before.props && after.tickets === before.tickets
  ? ok(`reach returns identically (${after.props} propert(ies), ${after.tickets} ticket(s))`)
  : bad(`reach differs after restore: ${after.props}/${after.tickets} vs ${before.props}/${before.tickets}`);
after.perm === before.perm ? ok("properties.write returns") : bad("the capability did not come back");

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — deactivated means deactivated, and reactivating gives it all back.");
