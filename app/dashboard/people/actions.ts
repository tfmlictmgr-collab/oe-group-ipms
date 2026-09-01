"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  generateInviteToken,
  hashInviteToken,
  buildInviteUrl,
  sendInviteEmail,
} from "@/lib/invitation";
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
  const accepted = await sendInviteEmail(
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
 * Frees a deactivated member's email address so it can be invited again.
 *
 * ⚠️ TWO stores hold that address and only one of them is ours.
 * `public.users.email` is the profile; `auth.users.email` is what actually
 * makes the address unavailable, because that is the unique column
 * `provisionInviteAccount` collides with. Releasing only the profile would free
 * the address in appearance and not in fact — the admin would be told it worked
 * and the re-invitation would still fail.
 *
 * They cannot be written in one transaction: the auth store is the provider's,
 * reached over its admin API, and it owns `auth.identities` alongside
 * `auth.users` — which is exactly why this uses that API rather than reaching
 * into the auth schema from SQL and updating half of what GoTrue reads.
 *
 * So the order is chosen for its FAILURE mode, not its success:
 *   1. the database function authorises, tombstones the profile, and audits
 *   2. the auth provider then releases the address for real
 *
 * If step 2 fails, the profile says released while the address is still taken —
 * visibly wrong, and safely repeatable, because `release_member_email` is
 * idempotent and returns the tombstone it already assigned. Doing it the other
 * way round would free the address first and leave the profile still claiming
 * it, which reads as "nothing happened" while the address is quietly gone.
 */
export async function releaseMemberEmail(
  userId: string
): Promise<ActionResult<{ formerEmail: string }>> {
  const supabase = await createClient();

  // Step 1. Every authorisation check lives in the function, not here — it
  // verifies the caller is an ACTIVE admin, that the target is in the same org,
  // that they are already deactivated, and that nobody is releasing themselves.
  const { data: tombstone, error } = await supabase.rpc("release_member_email", {
    p_user_id: userId,
  });
  if (error) return fail(error.message);

  // Read back what the address used to be, for the message. Done after the
  // call rather than before, so the value reported is the one actually
  // recorded rather than one read a moment earlier and assumed unchanged.
  const { data: row } = await supabase
    .from("users")
    .select("former_email")
    .eq("id", userId)
    .maybeSingle();
  const formerEmail = (row?.former_email as string | null) ?? "the address";

  // Step 2. The half that actually frees it.
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    email: String(tombstone),
    // Confirmed so the provider does not sit waiting on a verification email
    // sent to a .invalid address that can never be delivered or clicked.
    email_confirm: true,
    // The login is closed as well as renamed. The account already reaches
    // nothing (0194-0197), but leaving a signable credential attached to a
    // released identity is a loose end, not a control.
    ban_duration: "876000h",
  });

  if (authError) {
    return fail(
      `${formerEmail} was released on the member's record, but the sign-in provider refused: ${authError.message}`,
      "The address is not yet free to re-invite. Running this again is safe and will finish the job."
    );
  }

  revalidatePath("/dashboard/people/members");
  return ok({ formerEmail });
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


/**
 * First-tier vendor review (0238): put an application forward, or put it
 * forward to be refused. Never a decision — `approve_vendor_application`
 * refuses this same person, exactly as the tenant twin does.
 */
export async function recommendVendorApplication(
  applicationId: string,
  notes: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("recommend_vendor_application", {
    p_application_id: applicationId,
    p_notes: notes,
  });
  if (error) return failFromDb(error, "recommend this application");
  revalidatePath("/dashboard/people");
  revalidatePath("/dashboard/people/applications");
  return ok();
}

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
  revalidatePath("/dashboard/people/applications");
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
