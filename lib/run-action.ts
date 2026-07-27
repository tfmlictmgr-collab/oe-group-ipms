"use client";

import type { ActionResult } from "./action-result";

/**
 * Error messages are NOT masked on the client — only when crossing the Server
 * Action boundary. So a returned failure is re-thrown here, and every existing
 * `try { … } catch (e) { toast(e.message) }` keeps working while finally showing
 * the real reason.
 *
 *   const created = await runAction(createThing(input));
 */
export class ActionError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ActionError";
    this.hint = hint;
  }
}

export async function runAction<T>(promise: Promise<ActionResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new ActionError(result.message, result.hint);
  return result.data;
}

/** The hint, when there is one — for toasts that show a description line. */
export function hintOf(e: unknown): string | undefined {
  return e instanceof ActionError ? e.hint : undefined;
}

/**
 * What to show for a caught error. An ActionError is deliberate and safe to
 * display; anything else is an unexpected fault whose message may be masked or
 * internal, so it gets a generic line.
 */
export function messageOf(e: unknown, fallback = "Something went wrong. Please try again."): string {
  return e instanceof ActionError ? e.message : fallback;
}

/**
 * A toast description: the deliberate reason plus its hint.
 *
 * Anything that is not an ActionError is an unexpected fault, and its message is
 * either masked by Next or internal — neither belongs in front of a user, so it
 * gets one honest sentence instead.
 */
export function describeError(
  e: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  if (!(e instanceof ActionError)) return fallback;
  return e.hint ? `${e.message} ${e.hint}` : e.message;
}
