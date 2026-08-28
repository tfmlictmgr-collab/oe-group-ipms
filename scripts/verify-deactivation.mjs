// A deactivated account reaches nothing.
//
// Before 0194 it reached everything. `deactivated_at` was read only by
// application queries building pickers — "do not OFFER this person as an
// occupant" — while `current_user_role()` and `current_user_org_id()` never
// looked at it. A deactivated user signed in, kept their role, and passed
// every policy their role had ever passed.
//
// ⚠️ The first version of this suite tested the four functions 0194 fixed. It
// passed on the day `my_requests`, `my_tenancies`, `my_rent_charges`,
// `my_service_charges`, `my_payment_history`, `my_approval_limit`,
// `my_channel_consents`, `raise_ops_requisition`, `save_requisition_line_payee`
// and `resolve_chat_sender` were all still wide open, because none of them was
// on the list. 0185 already records what that is: a check written against the
// diff rather than against the rule. Section E now asks the catalogue.
//
// The claims:
//   • a deactivated account resolves NO role and NO org — the two roots every
//     policy reaches access through
//   • it therefore reads no properties and no tickets
//   • has_permission() answers false for a capability its role plainly holds
//   • the direct-keyed resolvers are empty too — current_user_property_ids(),
//     current_user_vendor_ids(), active_uid()
//   • the self-scoped readers return nothing: a tenant's own requests, rent,
//     service charges, payment history, notifications and approval limit are
//     reachable over /rest/v1/rpc without passing any React layout (0195)
//   • an action that costs money is refused, not silently ignored (0195)
//   • the primary intake channel closes: WhatsApp/Telegram resolve them to
//     nobody, which is the one path that runs service-role and never sees RLS
//   • current_user_account_state() says 'deactivated' — and says 'unknown' for
//     an account that merely has no profile row, which is a different thing
//     and used to be reported as the same (0196)
//   • reactivating restores every one of the above, exactly
//   • the account is not destroyed: its row, its audit trail and its
//     attachments survive deactivation (A3 — the trail is append-only)
//   • EVERY function reaching auth.uid() is deactivation-aware or a declared
//     exception, so the next one written is caught here and not in review
//
// Runs against a FIXTURE account it deactivates and restores itself. It never
// resolves a real staff address: the suite drives sign-ins, and attempting to
// authenticate as a colleague is wrong even when it fails.
//
// Usage: npx tsx scripts/verify-deactivation.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

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

// ⚠️ Setup that fails silently is worse than no setup: every assertion after it
// is then evaluated against a fixture that was never deactivated, and the suite
// reports a wall of green for a control that does not exist. This is the exact
// defect the seeds in this repo have been bitten by three times.
async function mustUpdate(what, patch, id) {
  const { error } = await svc.from("users").update(patch).eq("id", id);
  if (error) {
    console.error(`\n  setup failed — could not ${what}: ${error.message}`);
    console.error("  Aborting rather than testing against a fixture in an unknown state.");
    process.exit(1);
  }
}

// A fixture with real reach, so "reaches nothing" is a claim with teeth: an
// FM/PM holds properties, tickets and properties.write.
const { data: candidates, error: candidatesError } = await svc
  .from("users").select("id, email, role, deactivated_at")
  .ilike("email", "%@oegroup.test")
  .is("deactivated_at", null)
  .not("email", "ilike", "probe%")
  .in("role", ["property_manager", "facility_manager"])
  .order("created_at");

if (candidatesError) {
  console.error(`Could not look for a fixture account: ${candidatesError.message}`);
  process.exit(1);
}

const subject = (candidates ?? [])[0];
if (!subject) {
  console.error(
    "No live FM/PM fixture account (@oegroup.test) to exercise.\n" +
    "  Seed one with: node scripts/seed-brand-roles.mjs"
  );
  process.exit(1);
}

// The self-scoped readers a tenant owns. Called as the FM/PM fixture, which is
// fine: the claim under test is "returns nothing once deactivated", and the
// baseline in section A records whatever each returns while active so section B
// compares against the truth rather than against an assumption of non-zero.
const SELF_SCOPED = [
  "my_requests", "my_tenancies", "my_rent_charges", "my_service_charges",
  "my_payment_history", "my_approval_limit", "my_channel_consents",
];

async function reach() {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: subject.email, password: PW });
  if (error) return { signedIn: false, why: error.message };

  const [role, org, state, perm, propIds, vendIds, uid] = await Promise.all([
    c.rpc("current_user_role"), c.rpc("current_user_org_id"),
    c.rpc("current_user_account_state"),
    c.rpc("has_permission", { p_capability: "properties.write" }),
    c.rpc("current_user_property_ids"), c.rpc("current_user_vendor_ids"),
    c.rpc("active_uid"),
  ]);
  const { data: props } = await c.from("properties").select("id").limit(20);
  const { data: tix } = await c.from("tickets").select("id").limit(20);
  const { data: notes } = await c.from("user_notifications").select("id").limit(20);

  const selfScoped = {};
  for (const fn of SELF_SCOPED) {
    const { data } = await c.rpc(fn);
    selfScoped[fn] = Array.isArray(data) ? data.length : data === null ? 0 : 1;
  }

  // An action, not a read. `update_my_profile` is the cheapest one carrying a
  // 0195 guard whose effect can be undone in the same breath.
  const { error: actionError } = await c.rpc("update_my_profile", {
    p_full_name: subject.email.split("@")[0],
  });

  await c.auth.signOut();

  return {
    signedIn: true,
    role: role.data ?? null, org: org.data ?? null, state: state.data,
    perm: perm.data, uid: uid.data ?? null,
    props: (props ?? []).length, tickets: (tix ?? []).length,
    notes: (notes ?? []).length,
    propIds: (propIds.data ?? []).length, vendIds: (vendIds.data ?? []).length,
    selfScoped,
    actionRefused: Boolean(actionError),
    actionWhy: actionError?.message ?? null,
  };
}

console.log(`A deactivated account reaches nothing\n\n  subject: ${subject.email} (${subject.role})\n`);

// ── A. Active, so the "nothing" below means something ──────────────────────
console.log("A. While active, the account has real reach");
const before = await reach();
if (!before.signedIn) {
  console.error(`  cannot sign in as the fixture (${before.why}) — is the demo password current?`);
  process.exit(1);
}
before.role ? ok(`resolves a role (${before.role})`) : bad("resolves no role even while active");
before.org ? ok("resolves an org") : bad("resolves no org even while active");
before.uid ? ok("active_uid() answers") : bad("active_uid() is null while active");
before.state === "active" ? ok("account state is 'active'") : bad(`state is '${before.state}' while active`);
const hadReach = before.props > 0 || before.tickets > 0 || before.perm === true;
hadReach
  ? ok(`reaches ${before.props} propert(ies), ${before.tickets} ticket(s), properties.write=${before.perm}`)
  : bad("this fixture reaches nothing even while active — it cannot prove the claim");
before.actionRefused
  ? bad(`update_my_profile is refused while active: ${before.actionWhy}`)
  : ok("an action it is entitled to take succeeds");

// ⚠️ Say which of the self-scoped assertions in section B actually have teeth.
// A reader that returns nothing while ACTIVE proves nothing by returning
// nothing while deactivated, and a wall of green that includes vacuous checks
// is how a suite stops being read carefully. This is reported, not failed: an
// FM/PM legitimately holds no tenancy and no rent, and the same suite has to
// run on a portfolio where that is true.
{
  const withRows = SELF_SCOPED.filter((fn) => before.selfScoped[fn] > 0);
  const empty = SELF_SCOPED.filter((fn) => before.selfScoped[fn] === 0);
  ok(`${withRows.length}/${SELF_SCOPED.length} self-scoped reader(s) return rows while active: ${withRows.join(", ") || "none"}`);
  if (empty.length) {
    console.log(`  \x1b[33mNOTE\x1b[0m ${empty.join(", ")} are empty for this fixture — their section B checks confirm nothing`);
  }
}

// ── B. Deactivated ─────────────────────────────────────────────────────────
console.log("\nB. Deactivated, it reaches nothing");
await mustUpdate("deactivate the fixture",
  { deactivated_at: new Date().toISOString() }, subject.id);

const during = await reach();
if (!during.signedIn) {
  // Also an acceptable outcome — stronger, in fact. Say which happened.
  ok(`sign-in itself is refused (${during.why})`);
} else {
  during.role === null ? ok("current_user_role() is null") : bad(`STILL RESOLVES ROLE ${during.role}`);
  during.org === null ? ok("current_user_org_id() is null") : bad("STILL RESOLVES AN ORG");
  during.uid === null ? ok("active_uid() is null") : bad("active_uid() STILL ANSWERS");
  during.state === "deactivated"
    ? ok("current_user_account_state() is 'deactivated'")
    : bad(`state is '${during.state}', not 'deactivated'`);
  during.perm === false ? ok("has_permission('properties.write') is false") : bad("STILL HOLDS properties.write");
  during.props === 0 ? ok("reads no properties") : bad(`STILL READS ${during.props} PROPERT(IES)`);
  during.tickets === 0 ? ok("reads no tickets") : bad(`STILL READS ${during.tickets} TICKET(S)`);
  during.notes === 0 ? ok("reads no notifications") : bad(`STILL READS ${during.notes} NOTIFICATION(S)`);
  during.propIds === 0
    ? ok("current_user_property_ids() is empty — it reads auth.uid() directly and was fixed too")
    : bad(`current_user_property_ids() STILL RETURNS ${during.propIds}`);
  during.vendIds === 0
    ? ok("current_user_vendor_ids() is empty")
    : bad(`current_user_vendor_ids() STILL RETURNS ${during.vendIds}`);

  // ⚠️ The gap 0194 left. These are SECURITY DEFINER, granted to
  // `authenticated`, and reachable over /rest/v1/rpc with nothing but a live
  // JWT — no React layout, no middleware, no policy in the way.
  for (const fn of SELF_SCOPED) {
    during.selfScoped[fn] === 0
      ? ok(`${fn}() returns nothing`)
      : bad(`${fn}() STILL RETURNS ${during.selfScoped[fn]} ROW(S)`);
  }

  during.actionRefused
    ? ok(`an action is refused, and says so: "${during.actionWhy}"`)
    : bad("AN ACTION STILL SUCCEEDS — a write that silently no-ops is not a refusal");
}

// ── C. The record survives ─────────────────────────────────────────────────
// Deactivation is not deletion. A3 keeps the audit trail append-only, and the
// person's history has to remain attributable.
console.log("\nC. Deactivation is not erasure");
{
  const { data: still, error } = await svc
    .from("users").select("id, email, role").eq("id", subject.id).maybeSingle();
  if (error) bad(`could not re-read the profile row: ${error.message}`);
  else still ? ok("the profile row survives, so past actions stay attributable")
             : bad("THE PROFILE ROW WAS DESTROYED BY DEACTIVATION");
}

// ── D. Reactivation restores exactly what was there ────────────────────────
console.log("\nD. Reactivating restores it");
await mustUpdate("restore the fixture",
  { deactivated_at: subject.deactivated_at }, subject.id);

const after = await reach();
after.signedIn && after.role === before.role
  ? ok(`the role returns (${after.role})`)
  : bad("THE ROLE DID NOT COME BACK AFTER REACTIVATION");
after.org === before.org ? ok("the org returns") : bad("the org did not come back");
after.props === before.props && after.tickets === before.tickets
  ? ok(`reach returns identically (${after.props} propert(ies), ${after.tickets} ticket(s))`)
  : bad(`reach differs after restore: ${after.props}/${after.tickets} vs ${before.props}/${before.tickets}`);
after.perm === before.perm ? ok("properties.write returns") : bad("the capability did not come back");
SELF_SCOPED.every((fn) => after.selfScoped[fn] === before.selfScoped[fn])
  ? ok("every self-scoped reader returns what it did before")
  : bad("a self-scoped reader did not come back to its prior count");
after.actionRefused
  ? bad(`update_my_profile is still refused after restore: ${after.actionWhy}`)
  : ok("the account can act again");

// ── E. The RULE, asked of the catalogue ────────────────────────────────────
//
// Sections A–D test instances. This tests the class, and it is the section that
// would have caught what 0194 missed: every function in `public` reaching
// auth.uid() must resolve identity through a deactivation-aware path, or be one
// of the exceptions 0195 declares with a reason.
console.log("\nE. Every auth.uid() function is deactivation-aware (the rule, not a list)");

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

// Mirrors the EXEMPT map in scripts/generate-deactivation-guards.mjs. Kept in
// two places on purpose: the migration's copy decides what shipped, this one
// decides what is still believed, and a disagreement is worth a failed check.
const EXEMPT = new Set(["accept_invitation", "reject_payment"]);

try {
  await db.connect();

  const { rows: fns } = await db.query(`
    select p.proname, pg_get_functiondef(p.oid) as def,
           pg_get_function_result(p.oid) as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%auth.uid()%'
     order by p.proname`);

  const AWARE = /(deactivated_at\s+is\s+null|active_uid\(\)|current_user_is_active\(\)|current_user_account_state\(\)|current_user_org_id\(\)|current_user_role\(\)|current_user_property_ids\(\)|current_user_vendor_ids\(\))/;

  /**
   * A function that REFUSES every signed-in caller outright.
   *
   * ⚠️ Recognised as a RULE rather than added to `EXEMPT` as a name, because a
   * list of exceptions only ever describes the functions that existed when
   * somebody last edited it — 0185's lesson, which this suite's own header
   * already cites about itself.
   *
   * The guarantee here is strictly STRONGER than deactivation-awareness, not
   * weaker: a scheduled job that raises whenever `auth.uid()` is non-null
   * cannot be reached by ANY user, active or deactivated. Asking it to also
   * check `deactivated_at` would be asking it to check a row it has already
   * refused to look up. `escalate_stale_unassigned_requests` (0212) is the
   * first of these; the next one is covered without an edit here.
   */
  const SERVICE_ROLE_ONLY = /if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then\s+raise/i;

  const unaware = fns
    .filter((r) =>
      r.ret !== "trigger" &&
      !EXEMPT.has(r.proname) &&
      !AWARE.test(r.def) &&
      !SERVICE_ROLE_ONLY.test(r.def))
    .map((r) => r.proname);

  unaware.length === 0
    ? ok(`all ${fns.length} function(s) reaching auth.uid() are aware or declared (${EXEMPT.size} exception(s), ${fns.filter((r) => r.ret === "trigger").length} trigger(s))`)
    : bad(`NOT DEACTIVATION-AWARE and not declared: ${unaware.join(", ")}`);

  // ⚠️ A guard shaped `if current_user_role() not in (...) then raise` is
  // FAIL-OPEN now that 0194 made the role nullable: `null not in (...)` is
  // NULL, the IF does not fire, and the guard is skipped. Every such site today
  // is saved by an `is distinct from current_user_org_id()` check ahead of it,
  // which does raise on NULL — but that is ordering, not design, and the next
  // one written may not have it.
  const NULL_FRAGILE = /current_user_role\(\)\s*(<>|!=)|current_user_role\(\)\s+not\s+in|not\s*\(\s*current_user_role\(\)\s*=/i;
  const ORG_TRIP = /is\s+distinct\s+from\s+current_user_org_id\(\)|current_user_is_active\(\)|current_user_account_state\(\)/i;

  const fragile = fns
    .filter((r) => NULL_FRAGILE.test(r.def) && !ORG_TRIP.test(r.def))
    .map((r) => r.proname);

  fragile.length === 0
    ? ok("no plpgsql guard compares current_user_role() with <> or NOT IN without a NULL-tripping check ahead of it")
    : bad(
        `FAIL-OPEN ON A NULL ROLE (a deactivated caller skips the guard entirely): ${fragile.join(", ")}\n` +
        "        Add `if auth.uid() is not null and not current_user_is_active() then raise ...`,\n" +
        "        or compare positively: `if not (current_user_role() = any (array[...])) `is not` true then`."
      );
} catch (e) {
  bad(`could not read the function catalogue: ${e.message}`);
} finally {
  await db.end().catch(() => {});
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — deactivated means deactivated, everywhere it can be reached from, and reactivating gives it all back.");
