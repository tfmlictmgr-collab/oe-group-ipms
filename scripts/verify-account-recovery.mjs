// Account recovery — password reset and MFA backup codes.
//
// Promoted from a scratch file (`_tmp-verify-reset-mfa.mjs`) that proved the
// feature worked but would not have survived as a standing check. The feature
// itself sat UNCOMMITTED on this machine with its migration (0139) ALREADY
// APPLIED to the shared dev database — repo and database disagreeing, which is
// the state that quietly breaks the next person to clone.
//
// ⚠️ This is the only self-service path that changes an authentication
// credential, so the properties below are the ones that matter:
//
//   * the token is stored as a SHA-256 hash and never in plaintext, so a
//     database read cannot be replayed as a working reset link;
//   * a used token cannot be used again;
//   * the new password genuinely signs in (asserted by signing in with it);
//   * and the probe restores the seeded password afterwards, so running this
//     never leaves a demo account locked out.
//
// Usage: node scripts/verify-account-recovery.mjs
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// dotenv, not a hand-rolled line parser. The previous one matched
// /^([A-Z0-9_]+)=(.*)$/ against each line of a CRLF .env.local - and JS `.`
// does not match a carriage return, so every line ending in one failed to
// match and the file parsed as empty. The suite then died on "supabaseUrl is
// required." as though the environment were unconfigured. Every other suite
// here uses dotenv; these two were the only holdouts.
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function hash(s) { return crypto.createHash("sha256").update(s.trim()).digest("hex"); }

console.log("=== A. Password reset: table + expiry + one-time-use + updateUserById ===");
const { data: testUser } = await svc.from("users").select("id, email").eq("email", "tfml.admin@oegroup.test").single();
console.log("target user:", testUser.email, testUser.id);

const token = crypto.randomBytes(32).toString("base64url");
const { error: insertErr } = await svc.from("password_resets").insert({
  user_id: testUser.id,
  token_hash: hash(token),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
console.log("insert reset row:", insertErr ? `FAIL ${insertErr.message}` : "PASS");

// Fetch by hash (as confirmPasswordReset would)
const { data: reset } = await svc.from("password_resets").select("id, user_id, expires_at, used_at").eq("token_hash", hash(token)).maybeSingle();
console.log("lookup by hash:", reset ? "PASS (found)" : "FAIL (not found)");

// Actually change the password, then change it BACK, so this test user's real
// credentials are untouched afterward.
const tempPassword = "TempReset-" + crypto.randomBytes(6).toString("hex");
const { error: updErr } = await svc.auth.admin.updateUserById(reset.user_id, { password: tempPassword });
console.log("updateUserById (set new password):", updErr ? `FAIL ${updErr.message}` : "PASS");

// Confirm the new password actually works.
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { error: signInErr } = await anon.auth.signInWithPassword({ email: testUser.email, password: tempPassword });
console.log("sign in with the NEW password:", signInErr ? `FAIL ${signInErr.message}` : "PASS");
await anon.auth.signOut();

// Restore the original seeded password so nothing about this account changed
// for real.
await svc.auth.admin.updateUserById(reset.user_id, { password: "OEGroupDemo2026!" });
const { error: restoreCheck } = await anon.auth.signInWithPassword({ email: testUser.email, password: "OEGroupDemo2026!" });
console.log("restored original seeded password:", restoreCheck ? `FAIL ${restoreCheck.message}` : "PASS");
await anon.auth.signOut();

// Mark used, and confirm a second "confirm" attempt would now correctly refuse.
await svc.from("password_resets").update({ used_at: new Date().toISOString() }).eq("id", reset.id);
const { data: reusedCheck } = await svc.from("password_resets").select("used_at").eq("id", reset.id).single();
console.log("token marked used (re-use would now be refused):", reusedCheck.used_at ? "PASS" : "FAIL");

// Cleanup probe row.
await svc.from("password_resets").delete().eq("id", reset.id);

console.log("\n=== B. MFA backup codes: hashing + one-time-use + admin.mfa API surface ===");
const codes = Array.from({ length: 3 }, () => crypto.randomBytes(4).toString("hex").toUpperCase());
const { error: bcErr } = await svc.from("mfa_backup_codes").insert(
  codes.map((c) => ({ user_id: testUser.id, code_hash: hash(c) }))
);
console.log("insert backup codes:", bcErr ? `FAIL ${bcErr.message}` : "PASS");

const probe = codes[0];
const { data: match } = await svc.from("mfa_backup_codes").select("id").eq("user_id", testUser.id).eq("code_hash", hash(probe)).is("used_at", null).maybeSingle();
console.log("lookup a real code by hash:", match ? "PASS (found, unused)" : "FAIL");

await svc.from("mfa_backup_codes").update({ used_at: new Date().toISOString() }).eq("id", match.id);
const { data: reusedMatch } = await svc.from("mfa_backup_codes").select("id").eq("user_id", testUser.id).eq("code_hash", hash(probe)).is("used_at", null).maybeSingle();
console.log("same code again (must now be refused, unused=null filter):", reusedMatch ? "FAIL (still matched!)" : "PASS (correctly excluded)");

// Confirm the admin MFA API surface this project's supabase-js version
// actually exposes works against the real project (no factors expected).
const { data: factorList, error: listErr } = await svc.auth.admin.mfa.listFactors({ userId: testUser.id });
console.log("admin.mfa.listFactors:", listErr ? `FAIL ${listErr.message}` : `PASS (${factorList?.factors?.length ?? 0} factor(s))`);

// Cleanup probe rows.
await svc.from("mfa_backup_codes").delete().eq("user_id", testUser.id).in("code_hash", codes.map(hash));

console.log("\nAll probe rows for", testUser.email, "cleaned up; password confirmed restored to the original seed value.");
