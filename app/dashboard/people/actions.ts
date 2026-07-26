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

// Enrolment writes go through the caller's own session so RLS decides what is
// permitted. The one exception is acceptance itself (a SECURITY DEFINER function
// in 0020), because the invitee is not yet a member of any org.

const INVITABLE_ROLES = [
  "facility_manager",
  "fm_ops_staff",
  "finance_approver",
  "property_owner",
  "tenant",
  "vendor",
  "admin",
] as const;

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
 * The link is returned to the inviter rather than only emailed, because email
 * delivery (Resend) is not yet configured — an admin can share it over
 * WhatsApp today. Once RESEND_API_KEY is set, this also sends the email; the
 * link is still returned so there is always a fallback.
 */
export async function inviteMember(input: InviteInput): Promise<{
  url: string;
  emailed: boolean;
}> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me) throw new Error("Could not resolve your profile.");

  if (!["admin", "facility_manager"].includes(me.role)) {
    throw new Error("Only an administrator or an FM/PM may invite people.");
  }

  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  if (!INVITABLE_ROLES.includes(input.role as (typeof INVITABLE_ROLES)[number])) {
    throw new Error("That role cannot be invited.");
  }
  // Defence in depth — the RLS policy enforces this too.
  if (input.role === "admin" && me.role !== "admin") {
    throw new Error("Only an administrator may invite another administrator.");
  }

  // Someone already enrolled cannot be invited again.
  const { data: existing } = await supabase
    .from("users").select("id").eq("email", email).maybeSingle();
  if (existing) throw new Error("That person is already a member of this organisation.");

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
  if (error) {
    if (error.message.includes("row-level security")) {
      throw new Error("You are not permitted to issue that invitation.");
    }
    throw new Error(error.message);
  }

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const url = buildInviteUrl(origin, token);

  const emailed = await trySendInviteEmail(email, url, input.role, me.org_id);
  revalidatePath("/dashboard/people");
  return { url, emailed };
}

/**
 * Best-effort email. Returns false (not an error) when Resend isn't configured —
 * the caller still has the shareable link, so onboarding is never blocked.
 * Category "account", so replies reach the org's support inbox rather than the
 * unmonitored sending subdomain.
 */
async function trySendInviteEmail(
  to: string,
  url: string,
  role: string,
  orgId: string
): Promise<boolean> {
  const res = await sendEmail({
    to,
    orgId,
    category: "account",
    subject: "You've been invited to the OE Group portal",
    text: [
      `You have been invited to join the OE Group portal as ${role.replace(/_/g, " ")}.`,
      ``,
      `Set your password and get started:`,
      url,
      ``,
      `This link expires in 14 days and can only be used once.`,
      ``,
      `If you weren't expecting this, you can safely ignore it — or reply to this`,
      `email if you'd like to check it's genuine.`,
    ].join("\n"),
  });
  return res.sent;
}

export async function revokeInvitation(invitationId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/people");
}

/** Admin decision on a vendor awaiting approval. */
export async function setVendorApproval(vendorId: string, approve: boolean) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");

  const { error } = await supabase
    .from("vendors")
    .update({
      approval_status: approve ? "approved" : "rejected",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", vendorId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/people");
  revalidatePath("/dashboard/vendors");
}

/** Assign (or clear) the occupant of a unit. */
export async function assignUnitOccupant(unitId: string, userId: string | null) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("units")
    .update({ occupant_user_id: userId })
    .eq("id", unitId);
  if (error) {
    if (error.message.includes("row-level security")) {
      throw new Error("You can only assign occupants on properties you manage.");
    }
    throw new Error(error.message);
  }
  revalidatePath("/dashboard/people");
}

/** Approve or reject a public vendor application. Approval creates the vendor. */
export async function decideVendorApplication(applicationId: string, approve: boolean, notes?: string) {
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
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/people");
  revalidatePath("/dashboard/vendors");
}

/** Open or close the org's public vendor-application link. Admin only. */
export async function setVendorApplicationsOpen(open: boolean) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    throw new Error("Only an administrator can open or close vendor applications.");
  }
  const { error } = await supabase
    .from("orgs")
    .update({ vendor_applications_open: open })
    .eq("id", me.org_id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/people");
}
