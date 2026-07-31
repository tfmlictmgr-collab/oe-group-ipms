"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { hashToken, newResumeToken, resumeUrl, DRAFT_DAYS } from "@/lib/application-resume";
import { generateInviteToken, hashInviteToken, buildInviteUrl } from "@/lib/invitation";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Every action here is a thin wrapper: the state machine, the maker-checker
// rule and the property scoping all live in the database functions from
// migration 0082. This layer's only job is the two things that cannot happen
// inside Postgres — reading the request origin, and sending an email.

async function origin() {
  const h = await headers();
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`
  );
}

export async function recommendApplication(
  applicationId: string,
  approve: boolean,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_application_recommendation", {
    p_application_id: applicationId,
    p_approve: approve,
    p_reason: reason,
  });
  if (error) return failFromDb(error, "record that recommendation");
  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok();
}

export async function assignUnit(applicationId: string, unitId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_application_unit", {
    p_application_id: applicationId,
    p_unit_id: unitId,
  });
  if (error) return failFromDb(error, "assign that unit");
  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  return ok();
}

export async function requestMoreInfo(
  applicationId: string,
  applicantEmail: string,
  applicantName: string,
  orgId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();

  // A fresh token, exactly as starting a new application does — the old one
  // died at submission and must not be resurrected.
  const token = newResumeToken();
  const expiresAt = new Date(Date.now() + DRAFT_DAYS * 86_400_000).toISOString();

  const { error } = await supabase.rpc("record_application_info_request", {
    p_application_id: applicationId,
    p_reason: reason,
    p_token_hash: hashToken(token),
    p_expires_at: expiresAt,
  });
  if (error) return failFromDb(error, "send that request");

  try {
    const link = resumeUrl(await origin(), orgId, token);
    await sendEmail({
      to: applicantEmail,
      orgId,
      category: "account",
      entityType: "tenant_application",
      entityId: applicationId,
      subject: (ctx) => `A quick update needed on your ${ctx.brandName} application`,
      text: (ctx) =>
        [
          `Hello ${applicantName},`,
          ``,
          `The team reviewing your tenancy application with ${ctx.brandName} needs a`,
          `little more before they can decide:`,
          ``,
          reason,
          ``,
          `You can update your application here — this link is yours alone, and works`,
          `for the next ${DRAFT_DAYS} days:`,
          ``,
          link,
        ].join("\n"),
    });
  } catch (err) {
    // The request is already recorded; a failed email does not undo it. Logged
    // so it can be resent, never allowed to roll back a review decision.
    console.error("Could not email the info request:", err);
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok();
}

export async function approveApplication(
  applicationId: string,
  applicantEmail: string,
  applicantName: string,
  orgId: string,
  reason: string
): Promise<ActionResult<{ completed: boolean }>> {
  const supabase = await createClient();

  // Generated here, the same way `inviteMember` generates one — only the caller
  // ever holds the raw value, so only the caller can email it. The RPC stores
  // just the hash and tells us whether THIS call was the one that completed the
  // application (corporate needs two; this may be the first of them).
  const token = generateInviteToken();
  const { data: invitationId, error } = await supabase.rpc("record_application_approval", {
    p_application_id: applicationId,
    p_reason: reason,
    p_invite_token_hash: hashInviteToken(token),
  });
  if (error) return failFromDb(error, "record that approval");

  if (invitationId) {
    try {
      const url = buildInviteUrl(await origin(), token);
      await sendEmail({
        to: applicantEmail,
        orgId,
        category: "account",
        entityType: "invitation",
        entityId: invitationId,
        subject: (ctx) => `Your ${ctx.brandName} tenancy application was approved`,
        text: (ctx) =>
          [
            `Hello ${applicantName},`,
            ``,
            `Good news — your tenancy application with ${ctx.brandName} has been approved.`,
            ``,
            `Set up your account to get started:`,
            url,
            ``,
            `This link expires in 14 days and can only be used once.`,
          ].join("\n"),
      });
    } catch (err) {
      console.error("Could not email the approval invitation:", err);
    }
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok({ completed: Boolean(invitationId) });
}

export async function rejectApplication(applicationId: string, reason: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_application_rejection", {
    p_application_id: applicationId,
    p_reason: reason,
  });
  if (error) return failFromDb(error, "record that rejection");
  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok();
}

/**
 * A short-lived link to a private attachment. The storage policy
 * (`staff read their org documents`) already gates this to the caller's own
 * org — a signed URL is a convenience for the browser, not the security
 * boundary.
 */
export async function getAttachmentUrl(storagePath: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from("application-documents")
    .createSignedUrl(storagePath, 300);
  if (error) return failFromDb(error, "open that document");
  if (!data) return fail("Could not open that document.");
  return ok({ url: data.signedUrl });
}
