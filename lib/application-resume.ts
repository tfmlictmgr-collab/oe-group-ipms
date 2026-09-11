import crypto from "node:crypto";

// How an applicant gets back into their draft.
//
// The token is the only way in: only its SHA-256 is stored, so a database reader
// cannot resume someone's application, and the link dies the moment the
// application is submitted.
//
// Kept in one module because the hash is computed in three places — creating the
// draft, emailing the link, and rehydrating from it — and three copies of a
// hashing rule is three chances for one of them to drift.

export const DRAFT_DAYS = 30;

export const hashToken = (t: string) =>
  crypto.createHash("sha256").update(t).digest("hex");

export function newResumeToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * The absolute link an applicant returns through.
 *
 * The token travels as a query parameter, which is how password-reset and
 * magic-link flows work — but it does mean it can reach a referrer header, so the
 * tenancy route sends `Referrer-Policy: no-referrer` (next.config). It is a
 * capability token: 30 days, single application, revoked at submission.
 */
export function resumeUrl(origin: string, orgId: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/tenancy/${orgId}?resume=${encodeURIComponent(token)}`;
}
