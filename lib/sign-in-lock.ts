/**
 * The sign-in lock's shared vocabulary (0303) — safe for the browser: no
 * crypto, no database. The rules themselves live in SQL (`sign_in_gate`,
 * `record_sign_in_failure`); this only names their answers and words them.
 *
 * ⚠️ Every message below is decided by the ATTEMPT COUNT alone, never by
 * whether the email has an account. That is what keeps self-assessment A3
 * true: a wrong password and an unknown email read identically, wait
 * identically and lock identically.
 */

export const LOCK_AFTER = 5;

export type PasswordSignInResult =
  | { ok: true; userId: string }
  /** Wrong password (or unknown email). `failures` 1–4; the wait before the next try. */
  | { ok: false; reason: "refused"; failures: number; waitSeconds: number }
  /** Asked again before the wait was over. Nothing was checked. */
  | { ok: false; reason: "wait"; waitSeconds: number }
  | { ok: false; reason: "locked" }
  | { ok: false; reason: "captcha" | "rate" | "unconfirmed" | "network" | "error" };

export const REFUSED = "That email and password don't match. Check both and try again.";

export const LOCKED =
  "This sign-in is locked after too many failed attempts. Contact your administrator — they will send a reactivation link to your registered email.";

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** What the sign-in screen says for a result that is not a success. */
export function signInRefusal(r: Exclude<PasswordSignInResult, { ok: true }>): string {
  switch (r.reason) {
    case "refused":
      if (r.failures >= LOCK_AFTER - 1) {
        return `${REFUSED} One more failed attempt will lock this sign-in until your administrator unlocks it. Wait ${minutes(r.waitSeconds)} before trying again.`;
      }
      return r.waitSeconds > 0 ? `${REFUSED} Wait ${minutes(r.waitSeconds)} before trying again.` : REFUSED;
    case "wait":
      return `Too many failed attempts. Try again in ${minutes(r.waitSeconds)}.`;
    case "locked":
      return LOCKED;
    case "captcha":
      return "The security check didn't go through. Wait for the tick beside \"Sign in\", then try again.";
    case "rate":
      return "Too many attempts from this connection. Wait a few minutes and try again.";
    case "unconfirmed":
      return "This account hasn't been activated yet. Use the link in your invitation email.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return "Something went wrong signing you in. Try again, and tell your administrator if it keeps happening.";
  }
}
