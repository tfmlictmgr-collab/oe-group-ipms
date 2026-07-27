"use server";

import { createClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/invitation";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// The raw token never leaves the server: the page passes it here, we hash it,
// and only the hash is ever compared or logged.

export type InvitePreview = {
  orgName: string;
  role: string;
  email: string;
  fullName: string | null;
} | null;

/** Safe, unauthenticated peek so the accept page can say who invited whom. */
export async function previewInvitation(token: string): Promise<InvitePreview> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invitation_preview", {
    p_token_hash: hashInviteToken(token),
  });
  if (error || !data || data.length === 0) return null;
  const row = data[0];
  return {
    orgName: row.org_name,
    role: row.role,
    email: row.email,
    fullName: row.full_name,
  };
}

/**
 * Creates (or repairs) the invitee's login before they sign in.
 *
 * Why this exists: the page used to call `supabase.auth.signUp` in the browser.
 * With email confirmation enabled — the Supabase default — that returns a user
 * but NO session, so acceptance failed at the last step. Worse, it left a
 * half-made account behind: the retry then hit "already registered", sign-in
 * refused an unconfirmed address, and the person was stuck with no way forward.
 *
 * The confirmation round-trip was never earning anything. The invitation link
 * was EMAILED to that address, so possession of the link already proves control
 * of the mailbox — asking them to prove it again establishes no new fact and
 * adds a step that can fail. So the account is created server-side, already
 * confirmed, and the caller signs straight in.
 *
 * The one thing this must never do is set a password on an account that already
 * belongs to someone. Inviting an address that has a real account and silently
 * resetting its password would be account takeover with extra steps. A live
 * account is therefore left alone and the invitee is asked to sign in with it.
 */
export type ProvisionResult = ActionResult<{
  email: string;
  /** They already had a working account; use their existing password. */
  existingAccount: boolean;
}>;

export async function provisionInviteAccount(
  token: string,
  password: string
): Promise<ProvisionResult> {
  if (!password || password.length < 10) {
    return fail("Choose a password of at least 10 characters.");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { checkRateLimit, clientIp } = await import("@/lib/rate-limit");
  const { headers } = await import("next/headers");

  // A public endpoint keyed on a secret. The token is 32 random bytes and
  // stored only as a hash, so guessing is not the threat — but an unbounded
  // endpoint that creates accounts should still be bounded.
  const gate = await checkRateLimit("invite-provision", clientIp(await headers()), 10, "10 m");
  if (!gate.allowed) {
    return fail("Too many attempts. Please wait a few minutes and try again.");
  }

  const tokenHash = hashInviteToken(token);
  const { data: inv } = await supabaseAdmin
    .from("invitations")
    .select("id, email, status, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!inv || inv.status !== "pending" || new Date(inv.expires_at) <= new Date()) {
    return fail(
      "This invitation is invalid, already used, or has expired.",
      "Ask whoever invited you to send a fresh link."
    );
  }

  const email = String(inv.email).toLowerCase();

  // Exact lookup, not enumeration. The admin SDK only offers a paginated
  // listUsers, which means past the page size an existing account is simply not
  // found — and the invitee is then told their address is already registered,
  // with no way forward. TFML alone has 700+ staff.
  const { data: state } = await supabaseAdmin.rpc("auth_account_state", { p_email: email });
  const account = (state as
    | { user_id: string; is_confirmed: boolean; has_signed_in: boolean }[]
    | null)?.[0];

  if (!account) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) return fail(`Your login could not be created: ${error.message}`);
    return ok({ email, existingAccount: false });
  }

  // A confirmed account that has been used is somebody's. Never touch it.
  if (account.is_confirmed && account.has_signed_in) {
    return ok({ email, existingAccount: true });
  }

  // Otherwise it is a stranded shell from a failed attempt at this same flow —
  // created, never confirmed, never used. Complete it rather than leaving the
  // invitee permanently unable to accept.
  const { error } = await supabaseAdmin.auth.admin.updateUserById(account.user_id, {
    password,
    email_confirm: true,
  });
  if (error) return fail(`Your login could not be completed: ${error.message}`);
  return ok({ email, existingAccount: false });
}

/**
 * Redeems the invitation for the currently signed-in user. Everything the new
 * profile receives — org, role, property attaché links, unit, vendor — comes
 * from the invitation the inviter created, never from this request, so nobody
 * can sign up into a role they weren't granted.
 */
export type EnrolmentChannels = {
  phone: string;
  telegramChatId: string;
  whatsapp: boolean;
  sms: boolean;
  telegram: boolean;
};

export async function redeemInvitation(
  token: string,
  fullName: string,
  channels?: EnrolmentChannels
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", {
    p_token_hash: hashInviteToken(token),
    p_full_name: fullName,
    p_phone: channels?.phone ?? null,
    p_telegram_chat_id: channels?.telegramChatId ?? null,
    p_notify_whatsapp: channels?.whatsapp ?? false,
    p_notify_sms: channels?.sms ?? false,
    p_notify_telegram: channels?.telegram ?? false,
  });
  if (error) {
    // The invitation RPC raises for an expired, revoked or already-used link.
    // That reason is the whole message for someone stuck on this screen.
    return fail(
      error.message.replace(/^.*?:\s*/, ""),
      "Ask whoever invited you to send a fresh link — each one can only be used once."
    );
  }
  return ok();
}
