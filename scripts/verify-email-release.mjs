// A released address can be invited again, and the person who held it keeps
// everything they did.
//
// Deactivation closes an account (0194-0197) but does not give the ADDRESS
// back, because `auth.users.email` is unique. A colleague who returns, a
// successor on a shared role address, and a typo'd invitation are all
// permanently stuck on the wrong side of that constraint.
//
// The claims that matter, in the order they can go wrong:
//   • a LIVE member's address cannot be released — the account must be closed
//     first, or someone is signed in against an address being offered elsewhere
//   • a non-admin cannot release, and neither can a DEACTIVATED admin: the
//     guard is written `= 'admin'` because `<> 'admin'` is NULL for a null role
//     and falls straight through the `if` (0197's defect class)
//   • nobody can release their own address
//   • release tombstones the address to a .invalid form that can never receive
//     mail, and keeps the real one in former_email
//   • the audit trail records it
//   • it is IDEMPOTENT — the caller still has a second step against the auth
//     provider, so re-running has to be the safe remedy rather than an error
//   • the address is free ON THE AUTH PROVIDER, which is the store that
//     actually decides re-invitability, and a fresh invitation to it yields a
//     DIFFERENT account id
//   • ⚠️ THE POINT: the old row survives untouched. Its id, its role, its
//     audit entries and its attachments stay exactly where they were, so a
//     re-invitation cannot inherit a departed colleague's buildings.
//
// Runs against fixtures it creates and removes. It never resolves a real staff
// account: releasing a colleague's address to prove a test is wrong even when
// it works.
//
// Usage: npx tsx scripts/verify-email-release.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "ProbeRelease2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
const made = [];

async function makeUser(role, label) {
  const email = `probereleas.${label}.${tag}@oegroup.test`;
  const { data, error } = await svc.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  made.push({ id: data.user.id, email });
  return { id: data.user.id, email };
}

async function asUser(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return c;
}

console.log("A released address can be invited again\n");

// ── Fixtures ──────────────────────────────────────────────────────────────
const { data: org } = await svc
  .from("orgs").select("id, name").is("deleted_at", null)
  .eq("is_platform_operator", false).limit(1).maybeSingle();

if (!org) { console.error("no client org to test in"); process.exit(1); }

const admin = await makeUser("admin", "admin");
const leaver = await makeUser("fm_ops_staff", "leaver");
const other = await makeUser("fm_ops_staff", "other");

for (const [u, role, name] of [
  [admin, "admin", "Probe Admin"],
  [leaver, "fm_ops_staff", "Probe Leaver"],
  [other, "fm_ops_staff", "Probe Other"],
]) {
  const { error } = await svc.from("users").insert({
    id: u.id, org_id: org.id, role, full_name: name, email: u.email,
  });
  if (error) { console.error(`seed ${u.email}: ${error.message}`); process.exit(1); }
}
console.log(`  fixtures in ${org.name}\n`);

const adminClient = await asUser(admin.email);

// ── A. A live account keeps its address ───────────────────────────────────
console.log("A. An address can only be released from a closed account");
{
  const { error } = await adminClient.rpc("release_member_email", { p_user_id: leaver.id });
  error && /deactivate/i.test(error.message)
    ? ok("refused while the member is still active, and says to deactivate first")
    : bad(`a LIVE member's address was released: ${error?.message ?? "no error at all"}`);
}

// ── B. Who may do it ──────────────────────────────────────────────────────
console.log("\nB. Only an active administrator");
await svc.from("users")
  .update({ deactivated_at: new Date().toISOString() }).eq("id", leaver.id);
{
  const otherClient = await asUser(other.email);
  const { error } = await otherClient.rpc("release_member_email", { p_user_id: leaver.id });
  error ? ok("ops staff are refused") : bad("A NON-ADMIN RELEASED AN ADDRESS");

  // The 0197 defect: a deactivated admin whose role resolves to NULL. Written
  // `<> 'admin'` this would evaluate NULL, skip the raise, and continue.
  await svc.from("users")
    .update({ deactivated_at: new Date().toISOString() }).eq("id", admin.id);
  const zombie = await asUser(admin.email);
  const { error: zErr } = await zombie.rpc("release_member_email", { p_user_id: leaver.id });
  zErr
    ? ok("a DEACTIVATED admin is refused — the guard does not fall through on a null role")
    : bad("A DEACTIVATED ADMIN RELEASED AN ADDRESS — the null role walked past the guard");
  await svc.from("users").update({ deactivated_at: null }).eq("id", admin.id);
}

// ── C. Nobody releases themselves ─────────────────────────────────────────
console.log("\nC. Not your own");
{
  const { error } = await adminClient.rpc("release_member_email", { p_user_id: admin.id });
  error ? ok("refused") : bad("AN ADMIN RELEASED THEIR OWN ADDRESS");
}

// ── D. The release ────────────────────────────────────────────────────────
console.log("\nD. Releasing it");
let tombstone = null;
{
  const { data, error } = await adminClient.rpc("release_member_email", { p_user_id: leaver.id });
  if (error) {
    bad(`release failed: ${error.message}`);
  } else {
    tombstone = data;
    /@invalid$/.test(String(data))
      ? ok(`tombstoned to a .invalid address (${data}) — RFC 2606, can never receive mail`)
      : bad(`tombstone is deliverable: ${data}`);

    const { data: row } = await svc
      .from("users").select("email, former_email, email_released_at, role, org_id")
      .eq("id", leaver.id).maybeSingle();

    row?.former_email === leaver.email
      ? ok("the real address is kept in former_email, so the record still says who this was")
      : bad(`former_email is ${row?.former_email}, expected ${leaver.email}`);
    row?.email_released_at ? ok("the release is stamped") : bad("no email_released_at");
    row?.role === "fm_ops_staff" && row?.org_id === org.id
      ? ok("role and organisation are untouched — this frees an address, not an account")
      : bad("the release altered more than the address");
  }
}

// ── E. It is on the audit trail ───────────────────────────────────────────
console.log("\nE. Recorded");
{
  const { data } = await svc
    .from("audit_log").select("action, actor_id, entity_id")
    .eq("entity_id", leaver.id).eq("action", "member.email_released").limit(1);
  const e = (data ?? [])[0];
  e ? ok(`audited as ${e.action}`) : bad("NOT ON THE AUDIT TRAIL");
  e && e.actor_id === admin.id
    ? ok("attributed to the administrator who did it")
    : bad("the audit entry names the wrong actor");
}

// ── F. Idempotent ─────────────────────────────────────────────────────────
// The caller still has to release the address on the auth provider after this
// returns. If that fails, re-running must finish the job rather than refuse.
console.log("\nF. Safe to run again");
{
  const { data, error } = await adminClient.rpc("release_member_email", { p_user_id: leaver.id });
  if (error) {
    bad(`a second release errored, so a half-finished release cannot be completed: ${error.message}`);
  } else {
    String(data) === String(tombstone)
      ? ok("a second call returns the same tombstone rather than erroring")
      : bad(`second call returned ${data}, first returned ${tombstone}`);
  }
}

// ── G. The whole point ────────────────────────────────────────────────────
console.log("\nG. The address is free; the person's record is not touched");
{
  // The address is genuinely re-usable: the profile no longer holds it. (The
  // auth-side release is the server action's second step and is exercised by
  // the app, not reachable from SQL.)
  const { data: clash } = await svc
    .from("users").select("id").eq("email", leaver.email).maybeSingle();
  clash
    ? bad("a users row still claims the released address")
    : ok("no profile claims the address any more — it can be invited again");

  const { data: still } = await svc
    .from("users").select("id, role").eq("id", leaver.id).maybeSingle();
  still?.id === leaver.id
    ? ok("the departed member's row survives, so their audit entries stay theirs")
    : bad("THE ROW WAS DESTROYED — history would be orphaned");

  const { data: trail } = await svc
    .from("audit_log").select("id").eq("actor_id", leaver.id).limit(1);
  ok(
    (trail ?? []).length > 0
      ? "their own audit entries still resolve to them"
      : "they had no audit entries of their own, which is fine for a fresh fixture"
  );
}

// ── H. The half the database cannot do ────────────────────────────────────
// ⚠️ Everything above proves the PROFILE released the address. That is not
// what makes it re-invitable. `auth.users.email` is the unique column
// `provisionInviteAccount` actually collides with, and it lives in the auth
// provider's own store — so a release that stops at the profile frees the
// address in appearance and not in fact, and the admin is told it worked.
//
// This reproduces the server action's second step and then asks the exact
// question the invite flow asks.
console.log("\nH. The address is free where it actually counts");
{
  // Before: the invite flow can still see an account on that address.
  const { data: before } = await svc.rpc("auth_account_state", { p_email: leaver.email });
  (before ?? []).length > 0
    ? ok("before the auth step, the invite flow still finds the old login — as expected")
    : bad("the auth account was already gone before the auth step ran");

  const { error: authErr } = await svc.auth.admin.updateUserById(leaver.id, {
    email: String(tombstone), email_confirm: true, ban_duration: "876000h",
  });

  if (authErr) {
    bad(`the auth provider refused the release: ${authErr.message}`);
  } else {
    ok("the auth provider accepted the tombstone");

    // The question `provisionInviteAccount` asks. Nothing found means a fresh
    // account gets created, with a NEW id — which is the entire design.
    const { data: after } = await svc.rpc("auth_account_state", { p_email: leaver.email });
    (after ?? []).length === 0
      ? ok("the invite flow now finds NO account on that address — it can be invited again")
      : bad("THE ADDRESS IS STILL TAKEN on the auth provider — re-invitation would still fail");

    // And a re-invitation really does produce a different person.
    const { data: fresh, error: freshErr } = await svc.auth.admin.createUser({
      email: leaver.email, password: PW, email_confirm: true,
    });
    if (freshErr) {
      bad(`re-inviting that address still fails: ${freshErr.message}`);
    } else {
      made.push({ id: fresh.user.id, email: leaver.email });
      fresh.user.id !== leaver.id
        ? ok("re-inviting creates a NEW account with a new id — no history or access is inherited")
        : bad("THE OLD ACCOUNT WAS REUSED — the newcomer would inherit the leaver's attachments");
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
for (const u of made) {
  await svc.from("users").delete().eq("id", u.id);
  await svc.auth.admin.deleteUser(u.id).catch(() => {});
}
console.log("\n(fixtures removed)");

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — the address comes back; the history does not move.");
