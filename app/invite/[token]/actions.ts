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
