import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Mint a password-reset link on THIS app's own token path (0139): 32 random
 * bytes shown once in the link, only their SHA-256 stored in
 * `password_resets`, consumed by `confirmPasswordReset` on
 * `/reset-password/confirm?token=…`.
 *
 * ⚠️ Why this exists. `sendMemberPasswordReset` (0258) minted a SUPABASE
 * recovery link with `generateLink({ type: "recovery" })`, which lands carrying
 * its session in the URL fragment. The confirm page reads `?token=` and nothing
 * else, so every administrator-sent reset landed on "Missing reset link" — the
 * same fault `bootstrap-production.mjs` found and fixed for itself on 24 Sept.
 * Found again on 26 Sept, because the reactivation link after a sign-in lock
 * (0303) is that same link. One helper now, so the three senders (self-service,
 * administrator, reactivation) cannot drift apart again.
 *
 * Any earlier unused link for the same person is spent first: a live reset
 * link sitting in an old email is a second key nobody is watching.
 */
export async function mintResetLink(userId: string, origin: string, hours: number): Promise<string> {
  await supabaseAdmin
    .from("password_resets")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("used_at", null);

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const { error } = await supabaseAdmin.from("password_resets").insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
  });
  if (error) throw new Error(`The link could not be created: ${error.message}`);
  return `${origin.replace(/\/$/, "")}/reset-password/confirm?token=${token}`;
}
