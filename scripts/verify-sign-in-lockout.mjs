// Five wrong passwords lock the door (0303).
//
// The operator's rule (26 Sept 2026): count every failed password, on every
// org and role; wait 1, 2, 4, 8 minutes after failures 1–4; warn at 4; lock at
// 5 until an administrator unlocks and sends a reactivation link. Cloudflare
// stays in front.
//
// What this proves:
//   A. the code paths — the password is checked on the server, the gate is
//      asked BEFORE it, a lock bans at Supabase, the reactivation link is the
//      kind the reset page can read, and "Forgot password" cannot unlock;
//   B. the rules, in the database, on a staging world:
//      • an UNKNOWN email waits and locks exactly like a real one (A3: nothing
//        reveals which addresses are accounts), and nobody is emailed;
//      • a REAL account is warned at 4 and locked at 5;
//      • a session already open when the lock lands reaches nothing at once;
//      • a successful sign-in never clears a lock;
//      • only an administrator of the SAME organisation can unlock, never the
//        person themselves, never another org's admin;
//      • the break-glass unlock works;
//      • Node and SQL hash an address identically.
//
// Writes to staging only (guarded). Cleans up its probe account.
//
// Usage: npx tsx scripts/verify-sign-in-lockout.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { requireNonProductionTarget } from "./lib/target-env.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const check = (cond, m) => (cond ? ok(m) : bad(m));

const code = (rel) =>
  fs.readFileSync(path.join(rootDir, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

console.log("Five wrong passwords lock the door (0303)");

// ── A. The code paths ────────────────────────────────────────────────────────
section("A. The code paths");
{
  const panel = code("components/auth/sign-in-panel.tsx");
  check(!/auth\.signInWithPassword\(/.test(panel), "the sign-in panel no longer checks the password in the browser");
  check(/passwordSignIn\(/.test(panel), "…it asks the server action instead");

  const act = code("lib/password-sign-in.ts");
  const iGate = act.indexOf('"sign_in_gate"');
  const iTry = act.indexOf("signInWithPassword(");
  const iRec = act.indexOf('"record_sign_in_failure"');
  check(/^"use server"/.test(act.trim()), "the attempt runs on the server");
  check(iGate > 0 && iTry > iGate, "the lock and the wait are asked BEFORE the password is tried");
  check(/if \(gate\?\.locked\)/.test(act) && /wait_seconds > 0/.test(act), "a locked or waiting email is refused without trying the password");
  check(iRec > iTry, "a refused password is recorded after the attempt");
  check(/ban_duration:\s*"876000h"/.test(act), "a lock bans the account at Supabase, closing every other route");
  check(/"clear_sign_in_failures"/.test(act), "a success clears the count");
  check(/checkRateLimit\("sign-in-ip"/.test(act), "a per-IP limit on the visitor's own address replaces the one Supabase can no longer see");
  check(/captchaToken/.test(act), "the Cloudflare token is passed through to Supabase");

  const reset = code("app/reset-password/actions.ts");
  const iLocked = reset.indexOf("sign_in_locked_at)");
  const iInsert = reset.indexOf('from("password_resets").insert');
  check(iLocked > 0 && iLocked < iInsert, "\"Forgot password\" sends no link to a locked account");

  const people = code("app/dashboard/people/actions.ts");
  check(!/generateLink\(/.test(people), "the administrator's reset link is no longer a Supabase recovery link the page cannot read");
  check(/mintResetLink\(/.test(people), "…it is the app's own ?token= link (lib/reset-link)");
  const fn = people.slice(people.indexOf("export async function unlockAndSendReactivation"));
  const iUnlock = fn.indexOf('"unlock_member_sign_in"');
  const iBan = fn.indexOf('ban_duration: "none"');
  const iSend = fn.indexOf("sendMemberPasswordReset(");
  check(iUnlock > 0 && iBan > iUnlock && iSend > iBan, "unlock → lift the Supabase ban → send the link, in that order");

  const layout = code("app/dashboard/layout.tsx");
  check(/accountState === "locked"/.test(layout) && /login\?locked=1/.test(layout), "a locked session is signed out and told why");
}

// ── B. The rules, in the database ────────────────────────────────────────────
requireNonProductionTarget(rootDir, "This suite creates and removes a probe account and writes sign-in attempts.");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const nodeHash = (e) => crypto.createHash("sha256").update(e.trim().toLowerCase(), "utf8").digest("hex");
const rpc1 = async (fn, args) => {
  const { data, error } = await svc.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
};
async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const S = Date.now().toString(36).toUpperCase().slice(-6);
const stranger = `probe-lock-${S}@nowhere.invalid`;
let probe = null;

try {
  section("B1. Node and SQL hash an address identically");
  {
    const messy = `  Probe-Lock-${S}@Nowhere.INVALID `;
    const sql = await rpc1("sign_in_email_hash", { p_email: messy });
    check(sql === nodeHash(messy), "sign_in_email_hash matches sha256(trim(lower(email))) in Node");
  }

  section("B2. An unknown email waits and locks like a real one — and nobody is told");
  {
    const want = [60, 120, 240, 480, null];
    for (let i = 1; i <= 5; i++) {
      const r = await rpc1("record_sign_in_failure", { p_email: stranger });
      check(r.failures === i && r.wait_seconds === want[i - 1] && r.locked === (i === 5),
        `failure ${i}: ${i < 5 ? `wait ${want[i - 1] / 60} min` : "locked"}`);
      check(r.notify === null && r.user_id === null, `failure ${i}: no email — there is no owner to tell`);
      if (i === 1) {
        const g = await rpc1("sign_in_gate", { p_email: stranger });
        check(!g.locked && g.wait_seconds > 50 && g.wait_seconds <= 60, "the gate makes the next try wait about a minute");
      }
    }
    const g = await rpc1("sign_in_gate", { p_email: stranger });
    check(g.locked === true, "the gate reports it locked");
    await rpc1("clear_sign_in_failures", { p_email: stranger });
    check((await rpc1("sign_in_gate", { p_email: stranger })).locked === true, "a successful sign-in does not clear a lock");
    await rpc1("operator_unlock_sign_in", { p_email: stranger });
    check((await rpc1("sign_in_gate", { p_email: stranger })).locked === false, "the break-glass unlock clears it");
  }

  section("B3. A real account: warned at 4, locked at 5, cut off at once, unlocked only by its own admin");
  {
    const { data: orgs } = await svc.from("orgs").select("id, slug, delivery_brand").is("deleted_at", null);
    const oea = orgs.find((o) => o.delivery_brand === "OEA");
    const email = `probe-lock.${S.toLowerCase()}@oegroup.test`;
    const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
    if (error) throw new Error(`probe account: ${error.message}`);
    probe = { id: created.user.id, email };
    const up = await svc.from("users").upsert({ id: probe.id, org_id: oea.id, email, full_name: "Probe Lock", role: "fm_ops_staff" });
    if (up.error) throw new Error(`probe profile: ${up.error.message}`);

    const session = await login(email);
    const before = await session.rpc("current_user_account_state");
    check(before.data === "active", "the probe's session starts active");

    for (let i = 1; i <= 5; i++) {
      const r = await rpc1("record_sign_in_failure", { p_email: email.toUpperCase() });
      const want = i === 4 ? "warn" : i === 5 ? "locked" : null;
      check(r.notify === want && r.user_id === probe.id, `failure ${i}: ${want ? `the owner is emailed (${want})` : "no email yet"}`);
    }
    const { data: row } = await svc.from("users").select("sign_in_locked_at").eq("id", probe.id).single();
    check(Boolean(row.sign_in_locked_at), "the account is marked locked");
    const { count } = await svc.from("audit_log").select("id", { count: "exact", head: true })
      .eq("entity_id", probe.id).eq("action", "auth.sign_in_locked");
    check(count === 1, "the lock is in the audit trail");

    const state = await session.rpc("current_user_account_state");
    check(state.data === "locked", "the session opened BEFORE the lock now reads 'locked'");
    const own = await session.from("users").select("id").eq("id", probe.id);
    check((own.data ?? []).length === 0, "…and reaches nothing — not even its own profile");

    const self = await session.rpc("unlock_member_sign_in", { p_user_id: probe.id });
    check(Boolean(self.error), "the locked person cannot unlock themselves");

    const tfmlAdmin = await login("tfml.admin@oegroup.test");
    const cross = await tfmlAdmin.rpc("unlock_member_sign_in", { p_user_id: probe.id });
    check(Boolean(cross.error) && /another organisation/.test(cross.error.message), "another organisation's admin cannot unlock them");

    const oeaAdmin = await login("oea.admin@oegroup.test");
    const unlocked = await oeaAdmin.rpc("unlock_member_sign_in", { p_user_id: probe.id });
    check(!unlocked.error && unlocked.data === email, "their own organisation's admin unlocks them");
    const after = await session.rpc("current_user_account_state");
    check(after.data === "active", "the account is active again");
    check((await rpc1("sign_in_gate", { p_email: email })).locked === false, "and the gate is open, with the count reset");
    const again = await oeaAdmin.rpc("unlock_member_sign_in", { p_user_id: probe.id });
    check(Boolean(again.error) && /not locked/.test(again.error.message), "unlocking an account that is not locked is refused");
  }
} catch (e) {
  bad(`the run stopped: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await svc.rpc("operator_unlock_sign_in", { p_email: stranger }).then(() => {}, () => {});
  if (probe) {
    await svc.rpc("operator_unlock_sign_in", { p_email: probe.email }).then(() => {}, () => {});
    const del = await svc.from("users").delete().eq("id", probe.id);
    if (del.error) {
      await svc.from("users").update({ deactivated_at: new Date().toISOString() }).eq("id", probe.id);
    }
    await svc.auth.admin.deleteUser(probe.id).catch(() => {});
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32mALL CHECKS PASSED\x1b[0m — five wrong passwords lock the door, and only the right person reopens it.`
    : `\n\x1b[31m${failures} FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
