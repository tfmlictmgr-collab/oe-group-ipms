"use server";

import { portalOrigin } from "@/lib/portal-origin";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { hashOfferToken } from "@/lib/tenancy-offer-token";
import { generateInviteToken, hashInviteToken, buildInviteUrl } from "@/lib/invitation";
import { sendOfferAcceptedInvitation } from "@/lib/application-mail";

/**
 * The applicant answering their own offer (0263).
 *
 * ⚠️ Run through the SERVICE ROLE, not the anon client — deliberately the
 * opposite of `startApplication`, and for a reason worth stating. That action
 * writes a row whose RLS insert policy is the real enforcement, so using the
 * admin client there would make the policy decorative. Here there is no policy
 * that could enforce anything: the person has no account, and the row must be
 * reachable by exactly one token and by nothing else. The token IS the
 * authority, and the database functions check it. So the functions are granted
 * to `service_role` alone and revoked from `anon` AND `authenticated` — the
 * narrower shape, and one that cannot become 0210's fourth recurrence.
 *
 * Rate-limited by IP because that is the only guard a tokenised endpoint can
 * have. The token is 24 random bytes; this is belt to that brace.
 */

/** The applicant's organisation's own portal address (lib/portal-origin.ts). */
async function origin(orgId: string) {
  return portalOrigin(orgId);
}

export async function acceptOffer(
  token: string
): Promise<ActionResult<{ emailed: boolean }>> {
  const h = await headers();
  const gate = await checkRateLimit("offer-answer", clientIp(h), 20, "10 m");
  if (!gate.allowed) {
    return fail("Too many attempts from this connection.", "Wait a few minutes and try again.");
  }

  // Generated here and never sent to the database in the clear — the same rule
  // every invitation in this system follows, so only this request can email it.
  const inviteToken = generateInviteToken();

  const { data, error } = await supabaseAdmin.rpc("accept_tenancy_offer", {
    p_token_hash: hashOfferToken(token),
    p_invite_token_hash: hashInviteToken(inviteToken),
  });
  if (error) {
    // These refusals are written for the applicant — "this offer lapsed on
    // 12 October 2026" is the whole answer, and flattening it would leave a
    // person guessing why a link they were sent no longer works.
    return fail(error.message.replace(/^.*?:\s*/, ""));
  }

  const result = data as {
    invitation_id: string;
    org_id: string;
    application_id: string;
    email: string;
    name: string;
  };

  let emailed = false;
  try {
    emailed = await sendOfferAcceptedInvitation(
      {
        applicationId: result.application_id,
        orgId: result.org_id,
        email: result.email,
        name: result.name,
      },
      buildInviteUrl(await origin(result.org_id), inviteToken),
      null
    );
  } catch (err) {
    // The acceptance is recorded and the letting team has been notified. A mail
    // failure must never leave an accepted offer looking un-accepted.
    console.error("Could not email the tenant invitation:", err);
  }

  revalidatePath(`/tenancy/offer/${token}`);
  return ok({ emailed });
}

export async function declineOffer(
  token: string,
  reason: string
): Promise<ActionResult> {
  const h = await headers();
  const gate = await checkRateLimit("offer-answer", clientIp(h), 20, "10 m");
  if (!gate.allowed) {
    return fail("Too many attempts from this connection.", "Wait a few minutes and try again.");
  }

  const { error } = await supabaseAdmin.rpc("decline_tenancy_offer", {
    p_token_hash: hashOfferToken(token),
    // Optional, unlike a reviewer's reason: a person turning down a flat owes
    // nobody an explanation, and demanding one is how they close the tab
    // instead and the unit sits held.
    p_reason: reason.trim() || null,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath(`/tenancy/offer/${token}`);
  return ok();
}
