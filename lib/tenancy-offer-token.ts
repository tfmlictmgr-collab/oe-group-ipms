import crypto from "node:crypto";

/**
 * The applicant's acceptance token (0263).
 *
 * ⚠️ Kept apart from `lib/tenancy-offer.ts` for a build reason that is also a
 * correctness one: that module is imported by CLIENT components (the offer
 * panel, the terms form) for its formatting, and `node:crypto` cannot be
 * bundled for the browser. Splitting it means the hashing rule is never shipped
 * to a browser at all, which is where it belongs — the same separation
 * `lib/invitation.ts` gets for free by only ever being imported on the server.
 *
 * Only the SHA-256 is stored, so a database reader cannot accept somebody's
 * tenancy. One module because the hash is computed when the offer is issued,
 * when the link is emailed and when the applicant answers, and three copies of
 * a hashing rule is three chances for one to drift.
 */

export const hashOfferToken = (t: string) =>
  crypto.createHash("sha256").update(t.trim()).digest("hex");

export function newOfferToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Absolute, so it survives being pasted into WhatsApp or forwarded. */
export function offerUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/tenancy/offer/${encodeURIComponent(token)}`;
}
