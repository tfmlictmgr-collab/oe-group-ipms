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
import { hashOfferToken, newOfferToken, offerUrl } from "@/lib/tenancy-offer-token";
import { type OfferTerms } from "@/lib/tenancy-offer";
import { sendOfferLetter, sendRejectionNotice } from "@/lib/application-mail";
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

export type OfferInput = {
  rentAmount: string;
  serviceChargeAmount: string;
  depositAmount: string;
  otherChargesAmount: string;
  otherChargesLabel: string;
  termMonths: string;
  commencesOn: string;
  expiresOn: string;
  conditions: string;
};

const money = (v: string): number => {
  const n = Number((v ?? "").replace(/[,\s₦]/g, "") || "0");
  return Number.isFinite(n) ? n : NaN;
};

/** Every rule the offer form has to satisfy, in one place — the panel disables
 *  its button on the same answers, so what is offered and what is accepted
 *  cannot disagree. The database re-checks all of it regardless. */
function checkTerms(offer: OfferInput): string | null {
  const rent = money(offer.rentAmount);
  if (!Number.isFinite(rent) || rent <= 0) return "Give the rent as a number greater than zero.";
  const rest = [offer.serviceChargeAmount, offer.depositAmount, offer.otherChargesAmount].map(money);
  if (rest.some((n) => !Number.isFinite(n) || n < 0)) {
    return "The service charge, deposit and other charges must be zero or more.";
  }
  if (money(offer.otherChargesAmount) > 0 && offer.otherChargesLabel.trim().length < 2) {
    return "Say what the other charges are for.";
  }
  const term = Number(offer.termMonths);
  if (!Number.isInteger(term) || term < 1 || term > 120) {
    return "The term has to be between 1 and 120 months.";
  }
  if (!offer.commencesOn) return "Say when the tenancy commences.";
  if (!offer.expiresOn) return "Say by when the offer has to be accepted.";
  if (offer.expiresOn < new Date().toISOString().slice(0, 10)) {
    return "The acceptance deadline has to be today or later.";
  }
  return null;
}

function termsOf(offer: OfferInput): OfferTerms {
  return {
    rentAmount: money(offer.rentAmount),
    serviceChargeAmount: money(offer.serviceChargeAmount),
    depositAmount: money(offer.depositAmount),
    otherChargesAmount: money(offer.otherChargesAmount),
    otherChargesLabel: offer.otherChargesLabel.trim() || null,
    termMonths: Number(offer.termMonths),
    commencesOn: offer.commencesOn,
    expiresOn: offer.expiresOn,
    conditions: offer.conditions.trim() || null,
  };
}

/** Where the offer is FOR, read back from the record rather than passed in:
 *  the page that rendered the button is not the authority on which unit was
 *  assigned, and an offer letter naming the wrong flat is worse than a slow one. */
async function offerPlace(
  supabase: Awaited<ReturnType<typeof createClient>>,
  applicationId: string
) {
  const { data } = await supabase
    .from("tenant_applications")
    .select("properties(name, address), units(label)")
    .eq("id", applicationId)
    .maybeSingle();
  const property = data?.properties as unknown as { name: string; address: string | null } | null;
  const unit = data?.units as unknown as { label: string } | null;
  return {
    propertyName: property?.name ?? null,
    propertyAddress: property?.address ?? null,
    unitLabel: unit?.label ?? null,
  };
}

/**
 * Tier-2 approval — which now issues a LETTER OF OFFER, not an account.
 *
 * ⚠️ The sequence changed here (0263). This used to create the tenant's portal
 * invitation and email "your application was approved, set up your account" —
 * an account, naming no rent, no term, no deposit and nothing to accept,
 * because none of those figures existed anywhere at the moment of approval.
 * The offer is what a tenant actually agrees to, and the invitation is what
 * ACCEPTING it produces.
 *
 * For a corporate applicant this may be the first of two approvals, in which
 * case no offer is made: terms stated by one approver before the second has
 * looked would be an offer the organisation had not finished making.
 */
export async function approveApplication(
  applicationId: string,
  applicantEmail: string,
  applicantName: string,
  orgId: string,
  reason: string,
  offer: OfferInput
): Promise<ActionResult<{ completed: boolean; emailed: boolean }>> {
  const problem = checkTerms(offer);
  if (problem) return fail(problem, "An offer states what the tenant is agreeing to; it cannot be left blank.");

  const supabase = await createClient();
  const terms = termsOf(offer);

  // Generated here, so only the caller ever holds the raw value and only the
  // caller can email it — the rule every invitation in this system follows.
  const token = newOfferToken();

  const { data: offerId, error } = await supabase.rpc("record_application_approval", {
    p_application_id: applicationId,
    p_reason: reason,
    p_accept_token_hash: hashOfferToken(token),
    p_rent_amount: terms.rentAmount,
    p_service_charge_amount: terms.serviceChargeAmount,
    p_deposit_amount: terms.depositAmount,
    p_other_charges_amount: terms.otherChargesAmount,
    p_other_charges_label: terms.otherChargesLabel,
    p_term_months: terms.termMonths,
    p_commences_on: terms.commencesOn,
    p_expires_on: terms.expiresOn,
    p_conditions: terms.conditions,
  });
  if (error) return failFromDb(error, "record that approval");

  let emailed = false;
  if (offerId) {
    try {
      emailed = await sendOfferLetter(
        { applicationId, orgId, email: applicantEmail, name: applicantName },
        terms,
        await offerPlace(supabase, applicationId),
        offerUrl(await origin(), token)
      );
    } catch (err) {
      // The offer is recorded and its link is on the application page. A failed
      // send must never roll back a decision two people made.
      console.error("Could not email the offer letter:", err);
    }
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok({ completed: Boolean(offerId), emailed });
}

/**
 * Withdrawing an offer, so a corrected one can be made.
 *
 * ⚠️ Without this an offer with a mistyped rent is terminal: the application is
 * already `approved`, so the approval path cannot be walked again, and the one
 * live offer holds the unit. That is the dead end decision 30 was written
 * about, reached from the lettings side instead of the payment side.
 */
export async function withdrawOffer(
  offerId: string,
  applicationId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("withdraw_tenancy_offer", {
    p_offer_id: offerId,
    p_reason: reason,
  });
  if (error) return failFromDb(error, "withdraw that offer");
  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  return ok();
}

/** A corrected offer, on an application that is already approved. */
export async function reissueOffer(
  applicationId: string,
  applicantEmail: string,
  applicantName: string,
  orgId: string,
  offer: OfferInput
): Promise<ActionResult<{ emailed: boolean }>> {
  const problem = checkTerms(offer);
  if (problem) return fail(problem);

  const supabase = await createClient();
  const terms = termsOf(offer);
  const token = newOfferToken();

  const { error } = await supabase.rpc("issue_tenancy_offer", {
    p_application_id: applicationId,
    p_accept_token_hash: hashOfferToken(token),
    p_rent_amount: terms.rentAmount,
    p_service_charge_amount: terms.serviceChargeAmount,
    p_deposit_amount: terms.depositAmount,
    p_other_charges_amount: terms.otherChargesAmount,
    p_other_charges_label: terms.otherChargesLabel,
    p_term_months: terms.termMonths,
    p_commences_on: terms.commencesOn,
    p_expires_on: terms.expiresOn,
    p_conditions: terms.conditions,
  });
  if (error) return failFromDb(error, "make that offer");

  let emailed = false;
  try {
    emailed = await sendOfferLetter(
      { applicationId, orgId, email: applicantEmail, name: applicantName },
      terms,
      await offerPlace(supabase, applicationId),
      offerUrl(await origin(), token)
    );
  } catch (err) {
    console.error("Could not email the offer letter:", err);
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  return ok({ emailed });
}

export async function rejectApplication(
  applicationId: string,
  reason: string,
  applicant?: { email: string; name: string; orgId: string }
): Promise<ActionResult<{ emailed: boolean }>> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_application_rejection", {
    p_application_id: applicationId,
    p_reason: reason,
  });
  if (error) return failFromDb(error, "record that rejection");

  // ⚠️ Nothing was ever sent here. A rejection that reaches nobody is not a
  // rejection — decision 10's whole basis is that the reviewer's recorded reason
  // is CONTESTABLE, and a person cannot contest a decision they were never told
  // about. The reviewer's own words travel with it, which is also what makes the
  // 90-day retention meaningful rather than merely true.
  let emailed = false;
  if (applicant?.email) {
    try {
      emailed = await sendRejectionNotice(
        { applicationId, orgId: applicant.orgId, email: applicant.email, name: applicant.name },
        reason
      );
    } catch (err) {
      console.error("Could not email the rejection notice:", err);
    }
  }

  revalidatePath(`/dashboard/people/tenancy/${applicationId}`);
  revalidatePath("/dashboard/people/tenancy");
  return ok({ emailed });
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
export async function getAttachmentUrl(
  storagePath: string,
  download?: string
): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from("application-documents")
    .createSignedUrl(storagePath, 300, download ? { download } : undefined);
  if (error) return failFromDb(error, "open that document");
  if (!data) return fail("Could not open that document.");
  return ok({ url: data.signedUrl });
}
