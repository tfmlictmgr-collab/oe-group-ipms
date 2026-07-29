"use server";

import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { headers } from "next/headers";
import {
  splitSensitive, missingRequired, CONSENT_STATEMENT, REQUIRED_DOCUMENTS,
} from "@/lib/application-form";

// The public application. Everything here runs for someone with NO account, so
// each entry point is rate-limited and each one refuses unless the org has both
// the lettings module and an open application window.
//
// Written through the caller's anon session, not the service role: the RLS
// insert policy is the enforcement, and using the admin client here would make
// it decorative.

const DRAFT_DAYS = 30;

/** Hash a resume token the same way invitations do — only the hash is stored. */
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export type StartInput = {
  orgId: string;
  type: "individual" | "corporate";
  name: string;
  email: string;
  phone: string;
};

export async function startApplication(
  input: StartInput
): Promise<ActionResult<{ id: string; resumeToken: string }>> {
  const h = await headers();
  const gate = await checkRateLimit("apply-start", clientIp(h), 5, "10 m");
  if (!gate.allowed) {
    return fail(
      "Too many applications started from this connection.",
      "Wait a few minutes and try again, or ask the letting team for a link."
    );
  }

  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("Enter an email address we can reach you on.");
  }
  if (input.name.trim().length < 2) return fail("Enter your name.");

  const supabase = await createClient();

  // Unguessable, and only its hash is stored — so the link in the applicant's
  // email is the only way back into their draft.
  const resumeToken = crypto.randomBytes(24).toString("base64url");

  // Through an RPC, not a direct insert: an applicant may WRITE but must never
  // READ, and `.insert().select()` needs a SELECT policy for the returned row.
  // There deliberately isn't one — that absence is what stops the table being
  // enumerated. The function re-checks the same gate before inserting.
  const { data, error } = await supabase.rpc("start_tenant_application", {
    p_org_id: input.orgId,
    p_type: input.type,
    p_name: input.name.trim(),
    p_email: email,
    p_phone: input.phone.trim() || null,
    p_token_hash: hashToken(resumeToken),
    p_expires_at: new Date(Date.now() + DRAFT_DAYS * 86_400_000).toISOString(),
  });

  if (error || !data) {
    // A missing module and a closed window read the same to an applicant —
    // which org has which module is not their business.
    return fail(
      "This organisation is not accepting applications at the moment.",
      "If you were sent this link, please go back to whoever sent it."
    );
  }

  return ok({ id: data as string, resumeToken });
}

export async function saveDraft(
  applicationId: string,
  resumeToken: string,
  type: "individual" | "corporate",
  values: Record<string, unknown>
): Promise<ActionResult> {
  const supabase = await createClient();
  const { form, sensitive } = splitSensitive(type, values);

  // The TOKEN is the authority throughout — an application id proves nothing,
  // and there is no anon SELECT policy to check one against.
  const { data: saved, error } = await supabase.rpc("save_application_draft", {
    p_token_hash: hashToken(resumeToken),
    p_form: form,
    p_sensitive: sensitive,
  });

  if (error) return fail("Your answers could not be saved. Please try again.");
  if (!saved) {
    return fail(
      "This application link is no longer valid.",
      "Drafts expire after 30 days, and a submitted application cannot be edited."
    );
  }
  return ok();
}

export async function submitApplication(
  applicationId: string,
  resumeToken: string,
  type: "individual" | "corporate",
  values: Record<string, unknown>,
  consented: boolean
): Promise<ActionResult<{ reference: string }>> {
  if (!consented) {
    return fail(
      "We need your consent before we can accept the application.",
      "Tick the box confirming what your information will be used for."
    );
  }

  const supabase = await createClient();
  const { data: found } = await supabase.rpc("resume_application", {
    p_token_hash: hashToken(resumeToken),
  });
  const draft = Array.isArray(found) ? found[0] : found;
  if (!draft || draft.id !== applicationId) {
    return fail("This application link is no longer valid.");
  }

  const missing = missingRequired(type, values);
  if (missing.length > 0) {
    return fail(
      `Still needed: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.`,
      "Everything marked required has to be answered before we can accept it."
    );
  }

  // Required documents are checked HERE, not only in the browser. An
  // application missing its ID is not an application, and the reviewer should
  // never be the one to discover it.
  const { data: attachments } = await supabase
    .from("application_attachments")
    .select("kind")
    .eq("application_id", applicationId);

  const present = new Set((attachments ?? []).map((a) => a.kind));
  const missingDocs = REQUIRED_DOCUMENTS[type].filter((d) => !present.has(d.kind));
  if (missingDocs.length > 0) {
    return fail(
      `Still to upload: ${missingDocs.map((d) => d.label).join(", ")}.`,
      "These are needed before the application can be reviewed."
    );
  }

  const { form, sensitive } = splitSensitive(type, values);

  const { data: submitted, error } = await supabase.rpc("submit_tenant_application", {
    p_token_hash: hashToken(resumeToken),
    p_form: form,
    p_sensitive: sensitive,
    p_consent: CONSENT_STATEMENT,
  });

  if (error || !submitted) {
    return fail("The application could not be submitted. Please try again.");
  }

  return ok({ reference: String(submitted).slice(0, 8).toUpperCase() });
}

/**
 * A short-lived upload target inside the org's own folder.
 *
 * The path is built server-side from the org and application, never from the
 * client — otherwise a caller could name a path under a different org and the
 * storage policy, which only checks the first path segment, would allow it.
 */
export async function createUploadTarget(
  applicationId: string,
  resumeToken: string,
  kind: string,
  fileName: string,
  contentType: string,
  sizeBytes: number
): Promise<ActionResult<{ path: string; token: string }>> {
  const h = await headers();
  const gate = await checkRateLimit("apply-upload", clientIp(h), 30, "10 m");
  if (!gate.allowed) return fail("Too many uploads from this connection. Try again shortly.");

  const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!ALLOWED.includes(contentType)) {
    return fail(
      "That file type is not accepted.",
      "Please upload a PDF, JPG, PNG or WEBP."
    );
  }
  const MAX = 10 * 1024 * 1024;
  if (sizeBytes > MAX) {
    return fail("That file is larger than 10 MB.", "Photograph the document rather than scanning at full resolution.");
  }

  const supabase = await createClient();
  const { data: found } = await supabase.rpc("resume_application", {
    p_token_hash: hashToken(resumeToken),
  });
  const draft = Array.isArray(found) ? found[0] : found;
  if (!draft || draft.id !== applicationId) {
    return fail("This application link is no longer valid.");
  }

  // <org>/<application>/<kind>-<random>.<ext> — the org prefix is what the
  // storage policy authorises against.
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase().slice(0, 5) : "bin";
  const path = `${draft.org_id}/${applicationId}/${kind}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

  const { data: signed, error } = await supabaseAdmin.storage
    .from("application-documents")
    .createSignedUploadUrl(path);

  if (error || !signed) return fail("The upload could not be prepared. Please try again.");

  // Recorded through the RPC, which additionally refuses a path outside this
  // application's own folder — otherwise one valid token could register a row
  // pointing at another application's file.
  const { data: recorded, error: rowErr } = await supabase.rpc("record_application_attachment", {
    p_token_hash: hashToken(resumeToken),
    p_kind: kind,
    p_path: path,
    p_file_name: fileName,
    p_content_type: contentType,
    p_size: sizeBytes,
  });
  if (rowErr || !recorded) return fail("That document could not be recorded. Please try again.");

  return ok({ path, token: signed.token });
}
