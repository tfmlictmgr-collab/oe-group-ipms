"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  generateInviteToken,
  hashInviteToken,
  buildInviteUrl,
} from "@/lib/invitation";
import { sendEmail } from "@/lib/email";
import { roleLabel, INVITABLE_ROLES, ROLE_RANK, type InvitableRole, FM_PM } from "@/lib/roles";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Enrolment writes go through the caller's own session so RLS decides what is
// permitted. The one exception is acceptance itself (a SECURITY DEFINER function
// in 0020), because the invitee is not yet a member of any org.


export type InviteInput = {
  email: string;
  role: string;
  fullName: string;
  propertyIds: string[];
  propertyRelation: "manager" | "owner";
  /** A hierarchy node (0067) — how a regional manager is scoped. */
  nodeId?: string | null;
  unitId?: string | null;
  vendorId?: string | null;
  /**
   * The spending band for a `payment_approver` (0153). REQUIRED for that role
   * and forbidden for every other — `invitations_approval_tier_check` refuses
   * both mistakes, so an invitation issued without it could be created, emailed
   * and clicked, and would fail only when someone tried to accept it.
   */
  approvalTier?: 1 | 2 | 3 | null;
};

/**
 * Issues an invitation and returns the one-time link.
 *
 * The link is returned to the inviter as well as emailed, so onboarding still
 * works if mail is unconfigured, bounces, or the recipient never sees it — an
 * admin can always share it directly (WhatsApp is common here).
 */
export async function inviteMember(
  input: InviteInput
): Promise<ActionResult<{ url: string; accepted: boolean }>> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role, full_name").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  if (!["admin", ...FM_PM, "regional_manager"].includes(me.role)) {
    return fail("Only an administrator or a manager may invite people.");
  }

  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("Enter a valid email address.");
  }
  if (!INVITABLE_ROLES.includes(input.role as InvitableRole)) {
    return fail("That role cannot be invited.");
  }
  // Strictly below your own rank — defence in depth; `invitations_insert`
  // enforces the same rule via `role_rank()`.
  //
  // This replaced `input.role === "admin" && me.role !== "admin"`, which named
  // the one privileged role that existed when it was written. It left `executive`
  // and `regional_manager` issuable by a facility manager.
  if (input.role === "payment_approver" && ![1, 2, 3].includes(Number(input.approvalTier))) {
    return fail(
      "Choose a tier for this payment approver.",
      "A payment approver's authority is an amount, not a place — tier 1 approves up to the tier-1 limit, tier 2 up to the approval limit, tier 3 without limit."
    );
  }

  const peerAdmin = me.role === "admin" && input.role === "admin";
  if (!peerAdmin && (ROLE_RANK[input.role] ?? 0) >= (ROLE_RANK[me.role] ?? 0)) {
    return fail(
      `You cannot invite someone as ${roleLabel(input.role)}.`,
      "You may only invite roles below your own."
    );
  }

  // Someone already enrolled cannot be invited again.
  const { data: existing } = await supabase
    .from("users").select("id").eq("email", email).maybeSingle();
  if (existing) {
    return fail(
      "That person is already a member of this organisation.",
      "Find them under People -> Members to change their role or access."
    );
  }

  // Re-inviting replaces any live invitation rather than colliding with it.
  await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("org_id", me.org_id)
    .eq("status", "pending")
    .ilike("email", email);

  const token = generateInviteToken();

  const { data: invitation, error } = await supabase.from("invitations").insert({
    org_id: me.org_id,
    email,
    role: input.role,
    full_name: input.fullName.trim() || null,
    property_ids: input.propertyIds,
    property_relation: input.propertyRelation,
    // `invitations_insert` (0081) checks this is inside a subtree the inviter
    // holds, and `accept_invitation` applies it as a property_stakeholders row.
    node_id: input.nodeId || null,
    unit_id: input.unitId || null,
    vendor_id: input.vendorId || null,
    // Null for every role but payment_approver, which is what the constraint
    // requires — a tier on anyone else is refused just as firmly as a missing
    // one on an approver.
    approval_tier: input.role === "payment_approver" ? (input.approvalTier ?? null) : null,
    token_hash: hashInviteToken(token),
    invited_by: user.id,
  }).select("id").single();
  if (error) return failFromDb(error, "issue that invitation");

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const url = buildInviteUrl(origin, token);

  // delivery_brand decides whether the role reads "Operations Staff" (TFML) or
  // "Property Operations Staff" (OEA).
  const { data: org } = await supabase
    .from("orgs").select("delivery_brand").eq("id", me.org_id).single();

  // `accepted` is what the provider tells us synchronously; whether it ARRIVED
  // is decided later, by the delivery webhook, against this invitation.
  const accepted = await trySendInviteEmail(
    email,
    url,
    input.role,
    me.org_id,
    org?.delivery_brand ?? null,
    me.full_name ?? null,
    invitation?.id ?? null
  );
  revalidatePath("/dashboard/people");
  return ok({ url, accepted });
}

/**
 * Best-effort email. Returns whether the provider ACCEPTED it — never whether it
 * arrived; that is only known once the delivery webhook reports back. Returns
 * false (not an error) when Resend isn't configured: the caller still has the
 * shareable link, so onboarding is never blocked.
 * Category "account", so replies reach the org's support inbox rather than the
 * unmonitored sending subdomain.
 *
 * The copy names the CLIENT-FACING BRAND, never the holding entity (B1): a TFML
 * recipient reads "TFML portal". The role is rendered with the
 * brand-aware label, so TFML says "Operations Staff" where OEA says "Property
 * Operations Staff" — not the raw database value.
 */
async function trySendInviteEmail(
  to: string,
  url: string,
  role: string,
  orgId: string,
  brand: string | null,
  invitedByName: string | null,
  invitationId: string | null
): Promise<boolean> {
  const roleName = roleLabel(role, brand);

  const res = await sendEmail({
    to,
    orgId,
    category: "account",
    entityType: "invitation",
    entityId: invitationId,
    subject: ({ brandName }) => `You've been invited to the ${brandName} portal`,
    text: ({ brandName }) =>
      [
        `You've been invited to join the ${brandName} portal as ${roleName}.`,
        ...(invitedByName ? [``, `Invited by ${invitedByName}.`] : []),
        ``,
        `Set your password to get started:`,
        url,
        ``,
        `This link expires in 14 days and can only be used once.`,
        ``,
        `If you weren't expecting this invitation you can safely ignore this email`,
        `— or reply to it if you'd like to confirm it's genuine.`,
      ].join("\n"),
  });
  return res.sent;
}

export async function revokeInvitation(invitationId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId);
  if (error) return failFromDb(error, "revoke this invitation");
  revalidatePath("/dashboard/people");
  return ok();
}

/** Admin decision on a vendor awaiting approval. */
export async function setVendorApproval(
  vendorId: string,
  approve: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase
    .from("vendors")
    .update({
      approval_status: approve ? "approved" : "rejected",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", vendorId);
  if (error) return failFromDb(error, approve ? "approve this vendor" : "reject this vendor");
  revalidatePath("/dashboard/people");
  revalidatePath("/dashboard/vendors");
  return ok();
}

// NOTE: occupant assignment used to live here too, with no role check, so the
// "an occupant must be a tenant" rule was not an invariant and the two screens
// disagreed about what was legal. There is now ONE implementation, in
// `app/dashboard/properties/actions.ts`, and this page's UnitAssign imports it
// directly — a "use server" file cannot re-export, so the caller points at the
// canonical action rather than this file proxying it.


/** Approve or reject a public vendor application. Approval creates the vendor. */
export async function decideVendorApplication(
  applicationId: string,
  approve: boolean,
  notes?: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = approve
    ? await supabase.rpc("approve_vendor_application", {
        p_application_id: applicationId,
        p_notes: notes ?? null,
      })
    : await supabase.rpc("reject_vendor_application", {
        p_application_id: applicationId,
        p_notes: notes ?? null,
      });
  if (error) {
    return failFromDb(error, approve ? "approve this application" : "reject this application");
  }
  revalidatePath("/dashboard/people");
  revalidatePath("/dashboard/vendors");
  return ok();
}

/** Open or close the org's public vendor-application link. Admin only. */
// Opening and closing tenancy intake. Deliberately an ordinary org-admin
// setting rather than a permission-matrix toggle: it decides whether a public
// form accepts submissions, not who may see money or approve it. The
// non-delegable controls stay hardwired elsewhere.
export async function setTenantApplicationsOpen(open: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    return fail("Only an administrator can open or close tenancy applications.");
  }

  // The module gate, checked here too. Without it a facilities org could set a
  // flag that reads as "open" in its own settings while the public page still
  // refuses every application — a switch that lies about its own state.
  const { data: hasLettings } = await supabase.rpc("org_has_module", {
    p_org_id: me.org_id,
    p_module: "lettings",
  });
  if (!hasLettings) {
    return fail("Lettings is not enabled for this organisation.");
  }

  const { error } = await supabase
    .from("orgs")
    .update({ tenant_applications_open: open })
    .eq("id", me.org_id);
  if (error) return failFromDb(error, "change the tenancy application link");
  revalidatePath("/dashboard/people/tenancy");
  return ok();
}

/**
 * Open or close intake for ONE property.
 *
 * `auto` follows vacancy; `open` and `closed` are a person overruling it, which
 * is why the note and the actor are recorded. The privilege check lives in the
 * database function, not here — a server action is a convenience, never the
 * boundary.
 */
export async function setPropertyApplicationState(
  propertyId: string,
  state: "auto" | "open" | "closed",
  note?: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_property_application_state", {
    p_property_id: propertyId,
    p_state: state,
    p_note: note ?? null,
  });
  if (error) return failFromDb(error, "change this property's application window");
  revalidatePath("/dashboard/people/tenancy");
  return ok();
}

export async function setVendorApplicationsOpen(open: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    return fail("Only an administrator can open or close vendor applications.");
  }
  const { error } = await supabase
    .from("orgs")
    .update({ vendor_applications_open: open })
    .eq("id", me.org_id);
  if (error) return failFromDb(error, "change the application link");
  revalidatePath("/dashboard/people");
  return ok();
}
