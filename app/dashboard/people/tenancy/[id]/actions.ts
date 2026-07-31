"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import {
  examineDocument,
  duplicateFinding,
  sha256,
  VERIFICATION_MODEL,
  type FormClaims,
} from "@/lib/document-verification";
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
 * Runs the automated document checks (Day 8.5, locked decision 10).
 *
 * Three gates, all server-side, all re-asked here rather than trusted from the
 * page that offered the button:
 *   1. the org has BOTH `lettings` and `ai_document_checks` — the latter starts
 *      off and is switched on deliberately
 *   2. the caller holds `applications.run_document_checks`
 *   3. RLS still decides whether this caller can see the application at all
 *
 * What comes back is findings against documents. Nothing here writes to the
 * application's status, recommendation or decision, and the reviewer's own
 * reason remains required — findings inform it, they are never it.
 */
export async function runDocumentChecks(
  applicationId: string
): Promise<ActionResult<{ findings: number; skipped: number }>> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const [{ data: enabled }, { data: mayRun }] = await Promise.all([
    supabase.rpc("org_runs_document_checks", { p_org_id: me.org_id }),
    supabase.rpc("has_permission", { p_capability: "applications.run_document_checks" }),
  ]);
  if (!enabled) {
    return fail(
      "Automated document checks are switched off for this organisation.",
      "They start off by board decision and are enabled per organisation."
    );
  }
  if (!mayRun) return fail("You do not have permission to run document checks.");

  // Read the application through the CALLER's session, so RLS decides. Note
  // `sensitive` is not selected and never could be by this client — reviewers
  // read `application_overview`, which does not carry it.
  const { data: application } = await supabase
    .from("application_overview")
    .select("id, org_id, type, applicant_name, form")
    .eq("id", applicationId)
    .maybeSingle();
  if (!application) return fail("That application could not be found.");

  const { data: attachments } = await supabase
    .from("application_attachments")
    .select("id, kind, storage_path, file_name, content_type")
    .eq("application_id", applicationId)
    .order("uploaded_at");
  if (!attachments || attachments.length === 0) {
    return fail("There are no documents on this application to check.");
  }

  const { data: requirements } = await supabase
    .from("application_document_requirements")
    .select("kind, label")
    .eq("org_id", me.org_id)
    .eq("type", application.type);
  const labelFor = (kind: string) =>
    (requirements ?? []).find((r) => r.kind === kind)?.label ?? kind;

  const form = (application.form ?? {}) as Record<string, unknown>;
  const claims: FormClaims = {
    applicantName: String(application.applicant_name ?? ""),
    dateOfBirth: typeof form.date_of_birth === "string" ? form.date_of_birth : undefined,
    employer: typeof form.employer_name === "string" ? form.employer_name : undefined,
  };

  // Findings are written with the service role: a reviewer who could insert
  // findings directly could manufacture the evidence their own decision cites,
  // which is why there is no INSERT policy for `authenticated` on that table.
  const admin = supabaseAdmin;
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const a of attachments) {
    const { data: file, error: dlError } = await admin.storage
      .from("application-documents")
      .download(a.storage_path);
    if (dlError || !file) { skipped++; continue; }

    const bytes = Buffer.from(await file.arrayBuffer());
    const hash = sha256(bytes);

    // Record the hash so later applications can be compared against this one.
    await admin.from("application_attachments")
      .update({ content_sha256: hash })
      .eq("id", a.id);

    // How many OTHER applications already carry this exact file. Counted here,
    // never asked of a model, and the finding names none of them.
    const { data: sameHash } = await admin
      .from("application_attachments")
      .select("application_id")
      .eq("org_id", me.org_id)
      .eq("content_sha256", hash)
      .neq("application_id", applicationId);
    const otherApplications = new Set((sameHash ?? []).map((r) => r.application_id)).size;

    const label = labelFor(a.kind);
    const findings = await examineDocument(
      {
        attachmentId: a.id,
        label,
        fileName: a.file_name,
        contentType: a.content_type,
        bytes,
      },
      claims
    );

    const dup = duplicateFinding(
      a.id,
      label,
      otherApplications,
      a.content_type.startsWith("image/") ? "document_image" : "extracted_text"
    );
    if (dup) findings.push(dup);

    for (const f of findings) {
      rows.push({
        org_id: me.org_id,
        application_id: applicationId,
        attachment_id: f.attachmentId,
        kind: f.kind,
        severity: f.severity,
        summary: f.summary,
        detail: f.detail,
        model: VERIFICATION_MODEL,
        evidence_mode: f.evidenceMode,
      });
    }
  }

  // Replace the previous run's findings rather than accumulating them: two runs
  // over the same unchanged document would otherwise show every observation
  // twice, and a reviewer counting findings would be counting runs.
  await admin.from("application_document_findings")
    .delete()
    .eq("application_id", applicationId)
    .is("contested_by", null);

  if (rows.length > 0) {
    const { error } = await admin.from("application_document_findings").insert(rows);
    if (error) return failFromDb(error, "record those findings");
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  return ok({ findings: rows.length, skipped });
}

/** Marks a finding as disputed. It is never deleted — see `contest_document_finding`. */
export async function contestFinding(
  findingId: string,
  applicationId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("contest_document_finding", {
    p_finding_id: findingId,
    p_reason: reason,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
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
