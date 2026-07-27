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
import { roleLabel, INVITABLE_ROLES, type InvitableRole } from "@/lib/roles";
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
  unitId?: string | null;
  vendorId?: string | null;
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
): Promise<ActionResult<{ url: string; emailed: boolean }>> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role, full_name").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  if (!["admin", "facility_manager"].includes(me.role)) {
    return fail("Only an administrator or an FM/PM may invite people.");
  }

  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("Enter a valid email address.");
  }
  if (!INVITABLE_ROLES.includes(input.role as InvitableRole)) {
    return fail("That role cannot be invited.");
  }
  // Defence in depth — the RLS policy enforces this too.
  if (input.role === "admin" && me.role !== "admin") {
    return fail("Only an administrator may invite another administrator.");
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

  const { error } = await supabase.from("invitations").insert({
    org_id: me.org_id,
    email,
    role: input.role,
    full_name: input.fullName.trim() || null,
    property_ids: input.propertyIds,
    property_relation: input.propertyRelation,
    unit_id: input.unitId || null,
    vendor_id: input.vendorId || null,
    token_hash: hashInviteToken(token),
    invited_by: user.id,
  });
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

  const emailed = await trySendInviteEmail(
    email,
    url,
    input.role,
    me.org_id,
    org?.delivery_brand ?? null,
    me.full_name ?? null
  );
  revalidatePath("/dashboard/people");
  return ok({ url, emailed });
}

/**
 * Best-effort email. Returns false (not an error) when Resend isn't configured —
 * the caller still has the shareable link, so onboarding is never blocked.
 * Category "account", so replies reach the org's support inbox rather than the
 * unmonitored sending subdomain.
 *
 * The copy names the CLIENT-FACING BRAND, never the holding entity (B1): a TFML
 * recipient reads "TFML Nigeria portal". The role is rendered with the
 * brand-aware label, so TFML says "Operations Staff" where OEA says "Property
 * Operations Staff" — not the raw database value.
 */
async function trySendInviteEmail(
  to: string,
  url: string,
  role: string,
  orgId: string,
  brand: string | null,
  invitedByName: string | null
): Promise<boolean> {
  const roleName = roleLabel(role, brand);

  const res = await sendEmail({
    to,
    orgId,
    category: "account",
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

/** Assign (or clear) the occupant of a unit. */
export async function assignUnitOccupant(
  unitId: string,
  userId: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("units")
    .update({ occupant_user_id: userId })
    .eq("id", unitId);
  if (error) {
    if (/row-level security/i.test(error.message)) {
      return fail("You can only assign occupants on properties you manage.");
    }
    return failFromDb(error, "assign that occupant");
  }
  revalidatePath("/dashboard/people");
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
  revalidatePath("/dashboard/vendors");
  return ok();
}

/** Open or close the org's public vendor-application link. Admin only. */
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
