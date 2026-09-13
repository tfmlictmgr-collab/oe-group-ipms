import crypto from "node:crypto";

// Paying somebody by bank transfer (0289): the shared rules, in one place so
// the payee's page, the officer's form and the database cannot disagree about
// them.
//
// Server-only — `node:crypto` is imported for the token, and the hashing rule
// never needs to reach a browser. The client-safe half lives in
// `lib/payout-evidence-rules.ts`.

export {
  PAYOUT_BUCKET,
  PAYOUT_EVIDENCE_MAX_BYTES,
  PAYOUT_EVIDENCE_TYPES,
  PAYOUT_EVIDENCE_RULES,
  payoutEvidenceProblem,
  payoutEvidenceType,
  safeFileName,
} from "./payout-evidence-rules";

/** A link lasts this long. Long enough for somebody travelling; short enough
 *  that an old message forwarded around a site office stops working. Must
 *  agree with the fourteen days `request_payout_details` sets. */
export const PAYOUT_LINK_DAYS = 14;

/** Only the SHA-256 is stored — a database reader cannot submit anybody's
 *  details. The same rule as the tenancy offer (0263). */
export const hashPayoutToken = (t: string) =>
  crypto.createHash("sha256").update(t.trim()).digest("hex");

export function newPayoutToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Absolute, so it survives being pasted into WhatsApp or forwarded. */
export function payoutDetailsUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/payout-details/${encodeURIComponent(token)}`;
}
