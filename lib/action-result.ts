// How server actions report failure.
//
// Next.js replaces the message of any error thrown in a Server Action with an
// opaque digest in production builds. That is the right default — a thrown
// error can carry stack frames, connection strings, row contents — but it means
// every deliberate, user-facing message written in an action ("that invoice is
// already paid", "only an administrator may change this") reaches the user as:
//
//   "An error occurred in the Server Components render. The specific message is
//    omitted in production builds to avoid leaking sensitive details."
//
// Which is true, unhelpful, and indistinguishable from a crash. It also looks
// fine in development, where `next dev` shows the real message — so the fault
// only ever appears in the environment where it matters.
//
// The rule: a failure the user can do something about is RETURNED. Only genuine
// faults — a bug, an unreachable database — are left to throw, where masking is
// exactly what we want.

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; message: string; hint?: string };

export function ok(): ActionResult<void>;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T | void> {
  return { ok: true, data: data as T };
}

/**
 * An expected failure, phrased for the person reading it.
 * `hint` carries the "so do this" half when the fix is not obvious.
 */
export function fail(message: string, hint?: string): ActionResult<never> {
  return { ok: false, message, hint };
}

/** Turns a Postgres/PostgREST error into something worth showing. */
export function failFromDb(error: { message: string }, context: string): ActionResult<never> {
  const m = error.message;

  // RLS denials arrive as generic policy violations. Saying "policy violation"
  // to a facilities manager is not communication.
  if (/row-level security|violates row-level/i.test(m)) {
    return fail(
      `You do not have permission to ${context}.`,
      "If you believe you should, ask an administrator to check your role."
    );
  }
  if (/duplicate key/i.test(m)) {
    return fail(`That ${context} already exists.`);
  }
  if (/foreign key/i.test(m)) {
    return fail(
      `Could not ${context} — it is still referenced by other records.`,
      "Remove or reassign those first."
    );
  }
  return fail(`Could not ${context}: ${m}`);
}
