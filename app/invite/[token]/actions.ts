"use server";

import { createClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/invitation";

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
export async function redeemInvitation(token: string, fullName: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", {
    p_token_hash: hashInviteToken(token),
    p_full_name: fullName,
  });
  if (error) throw new Error(error.message);
}
