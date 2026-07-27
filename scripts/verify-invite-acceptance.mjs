// The invitation ACCEPTANCE path, end to end.
//
// `verify-invitations.mjs` covers issuing, hashing and expiry. It did not cover
// what actually happens when a person clicks the link, because it created its
// accounts with the admin API — which confirms the email as a side effect. The
// browser path did not, and that is exactly where it broke: with email
// confirmation enabled, `signUp` returns no session, acceptance fails at the
// last step, and a half-made account is left behind that blocks every retry.
//
// A test that sets up its fixtures differently from the real path is not
// testing the real path.
//
// Usage: npx tsx scripts/verify-invite-acceptance.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });

// Must match lib/invitation.ts exactly, or the test proves nothing.
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

// Lowercase deliberately: Supabase normalises addresses to lower case on
// write, so an email built with an uppercase stamp never matches on read —
// which silently broke both a check and this script's own cleanup, leaving
// accounts behind on every run.
const stamp = Date.now().toString(36).toLowerCase().slice(-6);
const PASSWORD = "InviteProbe2026!";
const cleanup = { emails: [], invitations: [] };

const { data: admin } = await svc.from("users").select("id, org_id")
  .eq("email", "demo@oegroup.test").single();
const orgId = admin.org_id;

async function issue(email, role = "viewer") {
  const token = newToken();
  const { data, error } = await svc.from("invitations").insert({
    org_id: orgId, email, role, token_hash: hashToken(token),
    invited_by: admin.id,
  }).select("id").single();
  if (error) throw new Error(`issue: ${error.message}`);
  cleanup.invitations.push(data.id);
  cleanup.emails.push(email);
  return token;
}

/** Mirrors provisionInviteAccount() in app/invite/[token]/actions.ts. */
async function provision(token, password) {
  const { data: inv } = await svc.from("invitations")
    .select("id, email, status, expires_at").eq("token_hash", hashToken(token)).maybeSingle();
  if (!inv || inv.status !== "pending" || new Date(inv.expires_at) <= new Date()) {
    return { ok: false, message: "invalid, used or expired" };
  }
  const email = inv.email.toLowerCase();
  const { data: state } = await svc.rpc("auth_account_state", { p_email: email });
  const account = state?.[0];

  if (!account) {
    const { error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return { ok: false, message: error.message };
    return { ok: true, email, existingAccount: false };
  }
  if (account.is_confirmed && account.has_signed_in) {
    return { ok: true, email, existingAccount: true };
  }
  const { error } = await svc.auth.admin.updateUserById(account.user_id, {
    password, email_confirm: true,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, email, existingAccount: false };
}

console.log("Invitation acceptance — the path a real person walks\n");

console.log("A. A fresh invitee can accept in one go");
{
  const email = `probe.fresh.${stamp}@oegroup-invite.test`;
  const token = await issue(email);

  const p = await provision(token, PASSWORD);
  p.ok ? ok("login provisioned") : bad(`provision failed — ${p.message}`);

  const c = createClient(URL_, ANON);
  const { error: signInErr } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  signInErr
    ? bad(`could not sign in — ${signInErr.message}`)
    : ok("signed in immediately — no email confirmation round trip");

  const { error: redeemErr } = await c.rpc("accept_invitation", {
    p_token_hash: hashToken(token), p_full_name: "Probe Fresh",
    p_phone: null, p_telegram_chat_id: null,
    p_notify_whatsapp: false, p_notify_sms: false, p_notify_telegram: false,
  });
  redeemErr ? bad(`redeem failed — ${redeemErr.message}`) : ok("invitation redeemed");

  const { data: prof } = await svc.from("users").select("role, org_id").eq("email", email).maybeSingle();
  prof?.role === "viewer" && prof.org_id === orgId
    ? ok("profile created with the invited role, in the invited org")
    : bad(`profile is ${JSON.stringify(prof)}`);

  const { data: inv } = await svc.from("invitations")
    .select("status").eq("token_hash", hashToken(token)).single();
  inv.status === "accepted" ? ok("invitation marked accepted") : bad(`status ${inv.status}`);
}

console.log("\nB. The stranded account — the case that blocked a real invitee");
{
  const email = `probe.stranded.${stamp}@oegroup-invite.test`;
  const token = await issue(email);

  // Staged with `email_confirm: false`, which leaves precisely the state the
  // old browser flow left: an account that exists, is unconfirmed, and has
  // never been signed into.
  //
  // Driving the anon `signUp` would be the truer reproduction, but it sends a
  // confirmation email and Supabase rate-limits those — a test that cannot run
  // twice in a row is not a test. (That rate limit is also, independently, a
  // good reason not to build enrolment on `signUp`.)
  const { error } = await svc.auth.admin.createUser({
    email, password: "SomeOldValue1!", email_confirm: false,
  });
  if (error) bad(`could not stage the stranded account — ${error.message}`);
  cleanup.emails.push(email);

  const { data: before } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const stale = before.users.find((u) => u.email?.toLowerCase() === email);
  stale && !stale.last_sign_in_at
    ? ok("staged: an account exists that has never been signed into")
    : bad("could not reproduce the stranded state");

  const p = await provision(token, PASSWORD);
  p.ok && p.existingAccount === false
    ? ok("the shell is completed rather than refused")
    : bad(`provision returned ${JSON.stringify(p)}`);

  const c = createClient(URL_, ANON);
  const { error: signInErr } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  signInErr ? bad(`still cannot sign in — ${signInErr.message}`) : ok("the invitee is unstuck");

  const { error: redeemErr } = await c.rpc("accept_invitation", {
    p_token_hash: hashToken(token), p_full_name: "Probe Stranded",
    p_phone: null, p_telegram_chat_id: null,
    p_notify_whatsapp: false, p_notify_sms: false, p_notify_telegram: false,
  });
  redeemErr ? bad(`redeem failed — ${redeemErr.message}`) : ok("acceptance completes");
}

console.log("\nC. A LIVE account's password is never overwritten");
{
  const email = `probe.live.${stamp}@oegroup-invite.test`;
  const REAL = "TheirRealPassword2026!";
  await svc.auth.admin.createUser({ email, password: REAL, email_confirm: true });
  cleanup.emails.push(email);

  // Make it a used account — confirmed AND signed in at least once.
  const c0 = createClient(URL_, ANON);
  await c0.auth.signInWithPassword({ email, password: REAL });

  const token = await issue(email, "tenant");
  const p = await provision(token, "AttackerChosen2026!");
  p.existingAccount === true
    ? ok("recognised as an existing account")
    : bad("treated a live account as a shell");

  const c = createClient(URL_, ANON);
  const { error: attackErr } = await c.auth.signInWithPassword({
    email, password: "AttackerChosen2026!",
  });
  attackErr
    ? ok("the invitation did NOT set a new password on it")
    : bad("ACCOUNT TAKEOVER — an invitation reset a live account's password");

  const { error: realErr } = await c.auth.signInWithPassword({ email, password: REAL });
  realErr ? bad("their real password stopped working") : ok("their own password still works");
}

console.log("\nD. A used, revoked or expired link provisions nothing");
{
  const email = `probe.spent.${stamp}@oegroup-invite.test`;
  const token = await issue(email);
  await svc.from("invitations").update({ status: "revoked" }).eq("token_hash", hashToken(token));

  const p = await provision(token, PASSWORD);
  !p.ok ? ok("a revoked link is refused before any account is made") : bad("PROVISIONED FROM A REVOKED LINK");

  const { data: list } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  !list.users.find((u) => u.email?.toLowerCase() === email)
    ? ok("no account was created")
    : bad("an account was created from a revoked invitation");
}

console.log("\nE. A forged token matches nothing");
{
  const p = await provision(newToken(), PASSWORD);
  !p.ok ? ok("an unissued token is refused") : bad("A FORGED TOKEN PROVISIONED AN ACCOUNT");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
//
// A probe that redeemed an invitation cannot be hard-deleted, and that is
// correct rather than inconvenient: `audit_log` is append-only at the database
// (0005 raises on DELETE, service role included) and `audit_log.actor_id`
// references the profile. 0025 already noted the consequence — anyone who has
// performed an audited action stays.
//
// So those fixtures are retired exactly as a real departing member is:
// deactivated and labelled. Deleting them would mean weakening the audit design
// to suit a test, which is the wrong way round.
{
  const { data: list } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  let removed = 0;
  let retired = 0;

  for (const email of [...new Set(cleanup.emails)].map((e) => e.toLowerCase())) {
    const { error: profileErr } = await svc.from("users").delete().eq("email", email);

    if (profileErr) {
      await svc.from("users").update({
        deactivated_at: new Date().toISOString(),
        full_name: "[test fixture — retained: the audit trail references it]",
      }).eq("email", email);
      retired++;
      continue;
    }

    const u = list.users.find((x) => x.email?.toLowerCase() === email);
    if (u) {
      const { error } = await svc.auth.admin.deleteUser(u.id);
      if (error) retired++;
      else removed++;
    }
  }

  await svc.from("invitations").delete().in("id", cleanup.invitations);
  console.log(
    `\n(cleanup: ${removed} removed, ${retired} retired — an audit-referenced account cannot be deleted)`
  );
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — an invitee gets in first time, and an invitation cannot take over an account."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
