"use server";

import { portalOrigin } from "@/lib/portal-origin";
import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ORG_DOMAIN_TAG } from "@/lib/org-host";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import {
  generateInviteToken,
  hashInviteToken,
  buildInviteUrl,
} from "@/lib/invitation";
import { sendEmail } from "@/lib/email";
import { roleLabel } from "@/lib/roles";

/**
 * Binds a hostname to an organisation, or frees it when given an empty string.
 *
 * The authority check lives in `set_org_domain` — operator-only and audited to
 * `operator_actions`. This layer adds the one thing Postgres cannot: busting the
 * host→org cache, so the new mapping is live on the next request rather than up
 * to an hour later.
 */
export async function setOrgDomain(
  orgId: string,
  domain: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_org_domain", {
    p_org_id: orgId,
    p_domain: domain.trim(),
    p_reason: reason,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  // Every host lookup shares one tag: a domain moving between orgs must not
  // leave the old host resolving to the old org from cache.
  revalidateTag(ORG_DOMAIN_TAG);
  revalidatePath("/orgs");
  return ok();
}

export type CreateOrgInput = {
  name: string;
  deliveryBrand: "TFML" | "OEA" | "direct";
  adminEmail: string;
  adminName: string;
  reason: string;
};

/**
 * Provisions a new organisation and invites its first administrator.
 *
 * The authority, the B7 permission baseline, the lettings flag, the
 * geopolitical hierarchy, the slug and the audit entry all live in
 * `operator_provision_org` (operator-only, 0097/0176) — this layer supplies
 * the one thing Postgres cannot: a one-time invitation token, shown to the
 * caller and emailed, with only its hash ever stored (same pattern as
 * `inviteMember`). The operator never chooses anyone's password; the nominee
 * accepts on their own.
 */
export async function createOrg(
  input: CreateOrgInput
): Promise<ActionResult<{ orgId: string; url: string; emailed: boolean }>> {
  const supabase = await createClient();

  const name = input.name.trim();
  if (!name) return fail("Give the organisation a name.");

  const adminEmail = input.adminEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return fail("Enter a valid email address for the first administrator.");
  }

  if (input.reason.trim().length < 10) {
    return fail(
      "Say why you're provisioning this organisation.",
      "The reason is recorded in operator_actions, visible to the org it concerns."
    );
  }

  const token = generateInviteToken();

  const { data: orgId, error } = await supabase.rpc("operator_provision_org", {
    p_name: name,
    p_delivery_brand: input.deliveryBrand,
    p_admin_email: adminEmail,
    p_admin_name: input.adminName.trim() || null,
    p_reason: input.reason.trim(),
    p_token_hash: hashInviteToken(token),
  });
  if (error) return failFromDb(error, "provision this organisation");

  const origin = await portalOrigin(orgId as string);
  const url = buildInviteUrl(origin, token);

  // Best-effort, exactly like `inviteMember`: the link is always returned, so
  // onboarding is never blocked on mail being configured or delivering.
  const emailed = await sendEmail({
    to: adminEmail,
    orgId,
    category: "account",
    entityType: "invitation",
    subject: ({ brandName }) => `You've been invited to the ${brandName} portal`,
    text: ({ brandName }) =>
      [
        `You've been invited to set up the ${brandName} portal as its first ${roleLabel("admin", input.deliveryBrand)}.`,
        ``,
        `Set your password to get started:`,
        url,
        ``,
        `This link expires in 14 days and can only be used once.`,
      ].join("\n"),
  }).then((r) => r.sent);

  revalidatePath("/orgs");
  return ok({ orgId, url, emailed });
}

/**
 * The approval ladder an organisation climbs, and whether its final stage
 * checks an amount band.
 *
 * ⚠️ Both authority checks live in the database — `operator_set_approval_chain`
 * (0248) and `operator_set_approval_tiers` (0261) gate on
 * `caller_is_operator_admin()` and write their own audit row naming the change
 * in words rather than as a column diff. This layer adds nothing but the
 * refusal a person can read, exactly like `setOrgDomain` above.
 *
 * 📌 Why it is here and not in an organisation's own Settings: decision 7 lists
 * payment approval among the controls that "stay hardwired and never appear as
 * toggles", and decision 23 took `delivery_brand` out of the org-writable
 * allowlist the moment it began selecting a ladder. An administrator who can
 * switch off the band they approve against is approving against nothing. The
 * operator portal is the only surface either of these may appear on.
 */
export async function setApprovalChainShape(
  orgId: string,
  shape: "standard" | "oea" | "single_stage" | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("operator_set_approval_chain", {
    p_org_id: orgId,
    p_shape: shape,
  });
  if (error) return failFromDb(error, "set this organisation's approval chain");
  revalidatePath("/orgs");
  return ok();
}

export async function setApprovalBands(
  orgId: string,
  enabled: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("operator_set_approval_tiers", {
    p_org_id: orgId,
    p_enabled: enabled,
  });
  if (error) return failFromDb(error, "change this organisation's approval bands");
  revalidatePath("/orgs");
  return ok();
}
