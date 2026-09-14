// The client-safe half of `lib/payout-evidence.ts`: the rules a browser needs
// to check a file BEFORE uploading it. The bucket enforces the same limit and
// the same types (0289), so these are courtesy, never the control.

export const PAYOUT_BUCKET = "payout-evidence";

/** Five megabytes, the same as a payment proof (0281) and the bucket's own limit. */
export const PAYOUT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export const PAYOUT_EVIDENCE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

/** Stated beside the file picker, before anyone chooses a file. */
export const PAYOUT_EVIDENCE_RULES = "A PDF or a photo (JPG, PNG, WEBP or HEIC), up to 5 MB.";

/** The server's answer when it must have a typed account name (0296). The
 *  page matches this exactly and opens the name box instead of dead-ending. */
export const PAYOUT_NAME_NEEDED = "Type the account name exactly as your bank shows it.";

/** The type the bucket will see — HEIC from some phones arrives with none. */
export function payoutEvidenceType(file: { type: string; name: string }): string {
  if (file.type) return file.type;
  if (/\.(heic|heif)$/i.test(file.name)) return "image/heic";
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  return "";
}

/** Why this file will be refused, or null if it will not. */
export function payoutEvidenceProblem(file: { size: number; type: string; name: string }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > PAYOUT_EVIDENCE_MAX_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB. A photo from a phone is usually well under that.`;
  }
  if (!(PAYOUT_EVIDENCE_TYPES as readonly string[]).includes(payoutEvidenceType(file))) {
    return "That kind of file cannot be attached. Use a PDF or a photo (JPG, PNG, WEBP or HEIC).";
  }
  return null;
}

/** A file name that is safe in a storage path and still recognisable. */
export function safeFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-");
  return base.replace(/^-|-$/g, "").slice(-80) || "document";
}
