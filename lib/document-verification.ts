import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

// Automated document verification (locked decision 10).
//
// This module reports OBSERVATIONS about documents. It does not decide, score,
// rank or recommend, and the shapes below are why that is structurally true
// rather than merely intended: `Finding` has no numeric field and no verdict
// field, and every finding carries the `attachmentId` it is about.
//
// ⚠️ What is never sent to a model:
//   • `tenant_applications.sensitive` — religion and marital status. Special
//     category under NDPA, held in a separate column for exactly this reason,
//     and not a parameter of any function here. It cannot be passed in.
//   • Any other applicant's data. Duplicate detection compares hashes computed
//     locally; no second applicant's document or name is ever in a prompt.
//
// ⚠️ Sending a document image to Claude makes Anthropic a **processor** (A3),
// which needs the DPA. Extracted text is preferred and used wherever the file
// allows it; `evidenceMode` records which happened, per finding, so the audit
// can show it.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const VERIFICATION_MODEL = "claude-sonnet-4-6";

export type FindingKind =
  | "extraction"
  | "format"
  | "consistency"
  | "completeness"
  | "duplicate";

export type Finding = {
  attachmentId: string;
  kind: FindingKind;
  /**
   * `attention` means a person should look. It has never meant reject, and
   * there is deliberately no third value — a third is where an observation
   * becomes a conclusion.
   */
  severity: "info" | "attention";
  summary: string;
  detail: string | null;
  evidenceMode: "extracted_text" | "document_image";
};

export type DocumentInput = {
  attachmentId: string;
  /** The requirement it was filed as — "Government-issued ID". */
  label: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
};

/** What the form claims, so a document can be checked for agreement with it. */
export type FormClaims = {
  applicantName: string;
  /** Never includes anything from `sensitive`. The caller cannot pass it. */
  dateOfBirth?: string;
  employer?: string;
};

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

/**
 * A document the model can read as text is sent as text. This is not an
 * optimisation — decision 10 prefers extracted text precisely so that fewer
 * identity documents leave the system as images.
 */
function evidenceModeFor(contentType: string): Finding["evidenceMode"] {
  return IMAGE_TYPES.has(contentType.toLowerCase()) ? "document_image" : "extracted_text";
}

const SYSTEM_PROMPT = `You examine documents submitted with a tenancy application and report OBSERVATIONS about them.

You are decision SUPPORT for a human reviewer. You must never decide, score, rank, or recommend an outcome, and you must never suggest whether the application should be approved or rejected. A human reviewer reads your observations and reaches their own conclusion with their own stated reason.

For the document given, report findings in these categories only:
- "extraction": what the document appears to say (names, dates, reference numbers, issuing body).
- "format": whether it looks like the kind of document it was filed as.
- "consistency": whether details on it agree with what the applicant wrote on their form.
- "completeness": whether it is legible, whole, and unexpired.

Severity is exactly one of:
- "info": an observation with nothing for the reviewer to resolve.
- "attention": something a person should look at themselves.

"attention" NEVER means the applicant should be refused. It means a human should look.

Rules:
- Describe only what you can see. If the image is unclear, say that, rather than guessing.
- Never infer or comment on the applicant's religion, marital status, ethnicity, health, or any other protected or special-category characteristic, even if the document shows it. If a document displays such information, do not repeat it.
- Never compare this applicant to any other person.
- Each summary must be a complete sentence of at least 10 characters that a person could act on, and that the applicant could dispute if it were wrong.

Reply with ONLY a JSON array, no prose and no code fence:
[{"kind":"extraction","severity":"info","summary":"...","detail":"..."}]

An empty array is valid if there is nothing worth reporting.`;

type RawFinding = {
  kind?: string;
  severity?: string;
  summary?: string;
  detail?: string | null;
};

const VALID_KINDS = new Set<FindingKind>([
  "extraction", "format", "consistency", "completeness", "duplicate",
]);

/**
 * Parses and — more importantly — CONSTRAINS the model's reply.
 *
 * Anything the model returns that is not one of the permitted kinds and the two
 * permitted severities is dropped, not coerced. A model that invents
 * `"severity":"reject"` must not have that quietly rounded to `attention`,
 * because the resulting finding would read as an observation while carrying a
 * verdict. Dropping it loses information; keeping it would launder a conclusion.
 */
export function parseFindings(
  rawText: string,
  attachmentId: string,
  evidenceMode: Finding["evidenceMode"]
): Finding[] {
  let parsed: unknown;
  try {
    const stripped = rawText.trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Finding[] = [];
  for (const item of parsed as RawFinding[]) {
    const kind = item?.kind as FindingKind;
    const severity = item?.severity;
    const summary = typeof item?.summary === "string" ? item.summary.trim() : "";

    // `duplicate` is computed locally from hashes and is never accepted from
    // the model — it has no way to know, and a hallucinated duplicate is an
    // accusation.
    if (!VALID_KINDS.has(kind) || kind === "duplicate") continue;
    if (severity !== "info" && severity !== "attention") continue;
    if (summary.length < 10) continue;

    out.push({
      attachmentId,
      kind,
      severity,
      summary,
      detail: typeof item.detail === "string" && item.detail.trim() ? item.detail.trim() : null,
      evidenceMode,
    });
  }
  return out;
}

/** Examines one document. Returns [] on any failure — a check that could not run reports nothing rather than something wrong. */
export async function examineDocument(
  doc: DocumentInput,
  claims: FormClaims
): Promise<Finding[]> {
  const evidenceMode = evidenceModeFor(doc.contentType);

  const context = [
    `Document filed as: ${doc.label}`,
    `File name: ${doc.fileName}`,
    `The applicant wrote their name as: ${claims.applicantName}`,
    claims.dateOfBirth ? `They gave their date of birth as: ${claims.dateOfBirth}` : null,
    claims.employer ? `They gave their employer as: ${claims.employer}` : null,
  ].filter(Boolean).join("\n");

  try {
    const content: Anthropic.MessageParam["content"] =
      evidenceMode === "document_image"
        ? [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: doc.contentType.toLowerCase() as
                  "image/png" | "image/jpeg" | "image/webp",
                data: doc.bytes.toString("base64"),
              },
            },
            { type: "text", text: context },
          ]
        : [
            {
              type: "text",
              text: `${context}\n\nDocument contents:\n${doc.bytes.toString("utf8").slice(0, 20000)}`,
            },
          ];

    const response = await anthropic.messages.create({
      model: VERIFICATION_MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock ? parseFindings(textBlock.text, doc.attachmentId, evidenceMode) : [];
  } catch (error) {
    console.error("Document examination failed:", error);
    return [];
  }
}

/**
 * A duplicate finding, computed from hashes rather than asked of a model.
 *
 * `earlierCount` is how many OTHER applications in this org already carry a
 * file with the same hash. The finding says that it happened and nothing more —
 * naming the other application would put one applicant's affairs into another
 * applicant's review, which is a privacy breach dressed as a fraud control.
 */
export function duplicateFinding(
  attachmentId: string,
  label: string,
  earlierCount: number,
  evidenceMode: Finding["evidenceMode"]
): Finding | null {
  if (earlierCount < 1) return null;
  return {
    attachmentId,
    kind: "duplicate",
    severity: "attention",
    summary: `This exact file has been submitted with ${earlierCount} other application${earlierCount === 1 ? "" : "s"} in this organisation.`,
    detail:
      `The "${label}" uploaded here is byte-for-byte identical to a file already on record. ` +
      `That has innocent explanations — a returning applicant, a shared guarantor — and it is ` +
      `worth asking about. The other application is deliberately not named.`,
    evidenceMode,
  };
}
