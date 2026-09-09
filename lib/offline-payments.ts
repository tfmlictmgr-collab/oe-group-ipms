// Off-platform payments — the facts both the server and the browser need.
//
// ⚠️ The size and type limits live HERE and nowhere else, and they are the same
// numbers `0281` gave the storage bucket. 0213 found three different limits on
// the vendor pack (15 MB bucket / 5 MB client / the board's 2 MB in neither),
// which is how "Send for review" stayed disabled with nothing on screen saying
// why. One number, stated to the person BEFORE the file picker.

export const PROOF_BUCKET = "payment-proofs";

/** Bytes. Matches `storage.buckets.file_size_limit` for this bucket exactly. */
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_MAX_LABEL = "5 MB";

/**
 * Matches `allowed_mime_types` on the bucket. HEIC/HEIF are included on both
 * sides: it is what an iPhone produces by default, and someone photographing a
 * teller slip is exactly the person that affects.
 */
export const PROOF_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export const PROOF_ACCEPT = PROOF_MIME_TYPES.join(",");

export const PROOF_RULES = [
  `PDF or a photo (JPG, PNG, WEBP, HEIC), up to ${PROOF_MAX_LABEL}`,
  "The amount, the date and our account name must all be readable",
  "A bank transfer receipt, a bank-app screenshot, or a stamped teller slip",
] as const;

export type OfflineMethod = "bank_transfer" | "bank_deposit";

export const METHOD_LABEL: Record<OfflineMethod, string> = {
  bank_transfer: "Bank transfer",
  bank_deposit: "Paid in at the bank",
};

export const METHOD_HINT: Record<OfflineMethod, string> = {
  bank_transfer: "You moved the money electronically into our account.",
  bank_deposit: "You paid cash or a cheque over the counter at the bank.",
};

export type ClaimStatus =
  | "submitted"
  | "confirmed"
  | "rejected"
  | "returned_for_correction";

/**
 * What a person is told their payment is doing. Deliberately says "checking",
 * not "pending" — a tenant who has paid wants to know somebody is looking, and
 * the word that matters to them is that nothing is required of them.
 */
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  submitted: "Being checked",
  confirmed: "Confirmed",
  rejected: "Not accepted",
  returned_for_correction: "Needs your attention",
};

export const STATUS_TONE: Record<ClaimStatus, "warning" | "success" | "danger" | "info"> = {
  submitted: "info",
  confirmed: "success",
  rejected: "danger",
  returned_for_correction: "warning",
};

export type AllocationPurpose = "rent" | "service_charge" | "deposit" | "other";

export const PURPOSE_LABEL: Record<AllocationPurpose, string> = {
  rent: "Rent",
  service_charge: "Service charge",
  deposit: "Deposit",
  other: "Credit on account",
};

export type AllocationInput = {
  purpose: AllocationPurpose;
  rent_charge_id?: string | null;
  service_charge_id?: string | null;
  property_id?: string | null;
  unit_id?: string | null;
  amount: number;
};

/**
 * The stage list, mirrored for display only.
 *
 * ⚠️ `offline_confirmation_stages()` is the authority and the server reads it;
 * this exists so a queue card can name a desk without a round trip. If they ever
 * disagree the database wins — which is why nothing here is used to DECIDE
 * anything, only to label it.
 */
export const CONFIRMATION_STAGES = [
  { order: 1, label: "Audit verification of the evidence", role: "payment_audit_approver" },
  { order: 2, label: "Executive authorisation", role: "executive" },
  { order: 3, label: "Payment Officer confirmation and ledger posting", role: "finance_approver" },
] as const;

/** Roles that sit on the confirmation chain — mirrors `offline_confirmation_roles()`. */
export const CONFIRMATION_ROLES = [
  "payment_audit_approver",
  "executive",
  "finance_approver",
] as const;

export function isConfirmer(role: string | null | undefined): boolean {
  return !!role && (CONFIRMATION_ROLES as readonly string[]).includes(role);
}

/**
 * A local check mirroring the bucket's own limits, so the person is told before
 * a 5 MB upload rather than after it. The bucket still refuses independently —
 * this is courtesy, not the control.
 */
export function proofProblem(file: { size: number; type: string; name: string }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > PROOF_MAX_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${PROOF_MAX_LABEL}.`;
  }
  if (!(PROOF_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `${file.type || "That file type"} cannot be accepted — use a PDF or a photo (JPG, PNG, WEBP, HEIC).`;
  }
  return null;
}

/**
 * Where a proof object lives: `<org>/<claim reference or draft id>/<filename>`.
 *
 * The org id FIRST, which is what `0164`'s storage convention requires and what
 * `0213` found the product itself was not doing — so every attach in the vendor
 * pack failed RLS silently. The rest is a per-upload folder so two people
 * attaching `receipt.pdf` on the same day cannot collide.
 */
export function proofPath(orgId: string, draftId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "proof";
  return `${orgId}/${draftId}/${safe}`;
}
