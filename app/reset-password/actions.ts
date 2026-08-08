"use server";

import crypto from "node:crypto";
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// Password reset, built on this app's own mail path rather than Supabase
// Auth's built-in one — see 0139 for why. Same shape as invitations (0020):
// a 32-byte token is shown to the requester exactly once (in the emailed
// link), and only its SHA-256 hash is ever stored, so a database read alone
// can never be replayed as a working reset.

const TOKEN_BYTES = 32;
const EXPIRY_HOURS = 1; // short-lived: this grants a password change, not a login

function generateResetToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Requests a reset link. ALWAYS returns ok() regardless of whether the email
 * matches an account — the same anti-enumeration principle the sign-in
 * REFUSED message and the invite-provisioning flow already follow. Whether
 * anything was actually sent is not observable from the response.
 */
export async function requestPasswordReset(email: string, origin: string): Promise<ActionResult> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    return fail("Enter a valid email address.");
  }

  // Keyed on the email itself, not just IP: the abuse this guards against is
  // mail-bombing one address from many sources, which a per-IP limit alone
  // would not catch.
  const ipGate = await checkRateLimit("password-reset-ip", clientIp(await headers()), 20, "10 m");
  const emailGate = await checkRateLimit("password-reset-email", trimmed, 3, "10 m");
  if (!ipGate.allowed || !emailGate.allowed) {
    // Deliberately the SAME success response as the happy path — a rate-limit
    // refusal that says so would tell an attacker probing addresses that this
    // one has been tried recently, which is itself a confirmation signal.
    return ok();
  }

  // auth_account_state (0081) is the exact-match lookup already used by the
  // invite flow, chosen there over listUsers() because it does not paginate —
  // TFML alone has 700+ staff. Reused here for the same reason.
  const { data: state } = await supabaseAdmin.rpc("auth_account_state", { p_email: trimmed });
  const account = (state as { user_id: string; is_confirmed: boolean }[] | null)?.[0];

  // No account, or one that never finished enrolling (no `users` profile —
  // the same "stranded shell" case the invite flow guards against): decline
  // silently. A reset link would either go nowhere useful or complete a
  // half-made signup through the wrong door.
  if (!account) return ok();
  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", account.user_id)
    .maybeSingle();
  if (!profile) return ok();

  const token = generateResetToken();
  const { error: insertErr } = await supabaseAdmin.from("password_resets").insert({
    user_id: account.user_id,
    token_hash: hashResetToken(token),
    expires_at: new Date(Date.now() + EXPIRY_HOURS * 3600_000).toISOString(),
  });
  if (insertErr) {
    console.error("could not create password reset token:", insertErr.message);
    return ok(); // still no signal to the caller either way
  }

  const url = `${origin.replace(/\/$/, "")}/reset-password/confirm?token=${token}`;
  const result = await sendEmail({
    to: trimmed,
    category: "account",
    orgId: profile.org_id,
    subject: (ctx) => `Reset your ${ctx.brandName} password`,
    text: (ctx) =>
      `A password reset was requested for your ${ctx.brandName} account.\n\n` +
      `Set a new password: ${url}\n\n` +
      `This link expires in ${EXPIRY_HOURS} hour and can only be used once. ` +
      `If you did not request this, you can ignore this email — your password has not changed.`,
  });
  if (!result.sent) {
    console.error("password reset email not sent:", result.reason);
  }

  return ok();
}

/**
 * Consumes a reset token and sets the new password. The token IS the proof of
 * identity here — there is no signed-in session yet — so this runs entirely
 * on the service role, exactly like `provisionInviteAccount`.
 */
export async function confirmPasswordReset(token: string, newPassword: string): Promise<ActionResult> {
  if (!newPassword || newPassword.length < 10) {
    return fail("Choose a password of at least 10 characters.");
  }

  const gate = await checkRateLimit("password-reset-confirm", clientIp(await headers()), 10, "10 m");
  if (!gate.allowed) {
    return fail("Too many attempts. Please wait a few minutes and try again.");
  }

  const tokenHash = hashResetToken(token);
  const { data: reset } = await supabaseAdmin
    .from("password_resets")
    .select("id, user_id, expires_at, used_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!reset || reset.used_at || new Date(reset.expires_at) <= new Date()) {
    return fail(
      "This reset link is invalid, already used, or has expired.",
      "Request a fresh one from the sign-in page."
    );
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(reset.user_id, {
    password: newPassword,
  });
  if (updateErr) {
    return fail(`Your password could not be changed: ${updateErr.message}`);
  }

  // ⚠️ Every EXISTING SESSION for this account is revoked.
  //
  // Without this a password reset does not lock anyone out. Supabase's
  // `updateUserById` changes the credential and leaves live refresh tokens
  // alone, so an attacker who already had a session keeps it — and "I think
  // someone got into my account, I've changed my password" is precisely the
  // situation this flow exists to answer. Changing the lock while the intruder
  // still holds a key is not a reset.
  //
  // Best-effort, and deliberately not fatal: the password HAS changed by this
  // point, and failing the whole action here would tell the user their reset
  // did not work when it did — sending them round again to a token this
  // function is about to burn.
  const { error: signOutErr } = await supabaseAdmin.auth.admin.signOut(reset.user_id, "global");
  if (signOutErr) {
    console.error("password changed but existing sessions were not revoked:", signOutErr.message);
  }

  // Marked used only after the password change actually succeeds — a failed
  // update must leave the link usable to try again, not burn it silently.
  await supabaseAdmin.from("password_resets").update({ used_at: new Date().toISOString() }).eq("id", reset.id);

  // Every other outstanding link for this account is invalidated too. Without
  // this, requesting three resets and using the oldest would leave two live,
  // unexpired links to the account sitting in old emails.
  await supabaseAdmin
    .from("password_resets")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", reset.user_id)
    .is("used_at", null);

  return ok();
}
