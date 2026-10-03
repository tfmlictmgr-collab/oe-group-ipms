// Whether a signed-in person may use the dashboard yet, as far as two-factor
// sign-in is concerned (0308).
//
// ONE definition, read by the middleware (which redirects), the dashboard
// layout (which shows the banner) and `/mfa` (which decides what to show).
// Three copies of "is this person due" is how a banner ends up promising a
// deadline the redirect does not keep.
//
// ⚠️ This is the APPLICATION's gate. It sends people to enrol; it does not stop
// a session that never touched the app from reading through PostgREST at AAL1.
// That is phase 3 — AAL2 in RLS — and waits until the operator's enrolment
// figures say nobody is left to lock out.

export type MfaGate =
  /** Nothing to do. */
  | { kind: "ok" }
  /** Enrolled, but this session has not answered the code yet. */
  | { kind: "verify" }
  /** Not enrolled, and the organisation's deadline has passed. */
  | { kind: "enroll" }
  /** Not enrolled; the deadline is still ahead. */
  | { kind: "due"; enforcedFrom: Date };

export function mfaGate(input: {
  hasVerifiedFactor: boolean;
  /** `currentLevel` from `getAuthenticatorAssuranceLevel()`. */
  currentLevel: string | null | undefined;
  /** `my_mfa_enforced_from()` — null where the org has not switched it on. */
  enforcedFrom: string | Date | null | undefined;
  now?: Date;
}): MfaGate {
  // Enrolled people answer the code whatever their organisation's setting:
  // someone who turned it on chose it, and a session that skipped the code
  // (any path other than the sign-in form) must not inherit their trust.
  if (input.hasVerifiedFactor) {
    return input.currentLevel === "aal2" ? { kind: "ok" } : { kind: "verify" };
  }
  if (!input.enforcedFrom) return { kind: "ok" };
  const from = new Date(input.enforcedFrom);
  if (Number.isNaN(from.getTime())) return { kind: "ok" };
  return (input.now ?? new Date()) >= from ? { kind: "enroll" } : { kind: "due", enforcedFrom: from };
}

/** Where the gate sends someone, and the only pages it never redirects. */
export const MFA_PATH = "/mfa";

/**
 * Paths behind the sign-in that the gate applies to. Public doors (tenancy
 * forms, payment pages, invite links, sign-in itself) are not gated: they
 * either have no session or are the way TO one.
 */
export function isMfaGated(path: string): boolean {
  return path.startsWith("/dashboard") || path === "/orgs";
}

/**
 * A `next` target is followed only if it is a path on THIS site — an open
 * redirect after a security step is the classic way to turn one into a
 * phishing hop.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/dashboard";
  }
  return next;
}
