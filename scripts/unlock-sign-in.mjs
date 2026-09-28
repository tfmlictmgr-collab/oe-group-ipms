// Break-glass: unlock a sign-in that no administrator can reach (0303).
//
// Five failed passwords lock an account until an administrator of its own
// organisation unlocks it and sends a reactivation link. That leaves one
// account nobody can unlock from the screen: the last operator admin, if they
// are the one locked. (The first answer is a SECOND operator admin, who can
// unlock the first from People; this is the answer when that fails.)
//
// Run by ICT, from a terminal, with the service role — exactly the authority
// `bootstrap-production.mjs` uses, and printed the same way: a one-time link,
// shown once, stored nowhere but as a hash. Recorded in the audit trail as
// `operator.sign_in_unlocked_break_glass`, with no actor, so it stands out.
//
// Usage:
//   node scripts/use-env.mjs prod        # then READ BACK the ref it prints
//   node scripts/unlock-sign-in.mjs --confirm <project-ref> --email person@example.com
//
// ⚠️ Deliver the printed link to the person over a channel you trust. It sets a
// password on their account for the next 24 hours.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL_ || !KEY) die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.");
const ref = URL_.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/i)?.[1];
if (!ref) die(`Cannot derive a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL (${URL_}).`);

// The same confirmation bootstrap asks for: name the project you mean.
const confirmed = flag("confirm");
if (confirmed !== ref) {
  die(
    `Refusing: --confirm did not match the project this .env.local points at.\n\n` +
    `  .env.local points at : ${ref}\n  --confirm given      : ${confirmed ?? "(absent)"}\n\n` +
    `Re-run with --confirm ${ref} once you have checked that is the world you mean.`
  );
}
const email = (flag("email") ?? "").trim().toLowerCase();
if (!email.includes("@")) die("--email <address> is required: the locked person's registered address.");

const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
if (!site) die("NEXT_PUBLIC_SITE_URL is not set in .env.local, so there is nowhere to send the person.");

const svc = createClient(URL_, KEY, { auth: { persistSession: false } });
console.log(`\nBreak-glass sign-in unlock — project ${ref}\n`);

const { data: user, error: uErr } = await svc
  .from("users").select("id, full_name, deactivated_at, email_released_at, sign_in_locked_at")
  .ilike("email", email).maybeSingle();
if (uErr) die(`Cannot read the account: ${uErr.message}`);
if (!user) die(`No member has the address ${email}. Nothing was changed.`);
if (user.deactivated_at || user.email_released_at) {
  die(`${email} is deactivated or released. That is not a lock; restore or re-invite through People.`);
}
if (!user.sign_in_locked_at) {
  console.log(`  ${email} is not locked. Clearing any failed-attempt count anyway.`);
}

// 1. The lock, in the database: cleared and audited.
const { error: unlockErr } = await svc.rpc("operator_unlock_sign_in", { p_email: email });
if (unlockErr) die(`The lock could not be cleared: ${unlockErr.message}`);
ok("lock cleared and recorded in the audit trail");

// 2. The ban at the sign-in provider — lifted BEFORE the link, or the new
//    password would be refused.
const { error: banErr } = await svc.auth.admin.updateUserById(user.id, { ban_duration: "none" });
if (banErr) die(`The sign-in provider refused to lift its block: ${banErr.message}\nRe-running is safe.`);
ok("sign-in provider block lifted");

// 3. A reactivation link on the app's own token path (0139, lib/reset-link.ts):
//    earlier unused links spent first, 32 random bytes shown once, hash stored.
await svc.from("password_resets").update({ used_at: new Date().toISOString() })
  .eq("user_id", user.id).is("used_at", null);
const token = crypto.randomBytes(32).toString("base64url");
const { error: insErr } = await svc.from("password_resets").insert({
  user_id: user.id,
  token_hash: crypto.createHash("sha256").update(token).digest("hex"),
  expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
});
if (insErr) die(`Unlocked, but the link could not be created: ${insErr.message}\nRe-running is safe.`);

console.log(
  `\nUnlocked: ${user.full_name ?? email} <${email}>\n\n` +
  `ONE-TIME REACTIVATION LINK — shown once, stored nowhere but as a hash, valid 24 hours:\n\n` +
  `  ${site.replace(/\/$/, "")}/reset-password/confirm?token=${token}\n\n` +
  `Give it to them over a channel you trust. They set a new password with it, then sign in.\n`
);
