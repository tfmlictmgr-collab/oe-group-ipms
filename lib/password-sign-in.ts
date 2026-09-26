"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import type { PasswordSignInResult } from "@/lib/sign-in-lock";

/**
 * A password sign-in, made HERE rather than in the browser (0303).
 *
 * ⚠️ Why the attempt moved server-side. Five wrong passwords lock an account,
 * which means failures must be counted where the counting cannot be skipped
 * and cannot be faked. In the browser it could be skipped; and a "report a
 * failure" endpoint would let anyone lock a victim out by reporting five fakes
 * without solving Cloudflare once. Here, a failure is only ever counted for an
 * attempt this server actually made, each carrying its own Turnstile token
 * (passed through to Supabase, whose CAPTCHA setting verifies it).
 *
 * ⚠️ Supabase now sees THIS server's address, not the visitor's, so its own
 * per-IP sign-in limit applies to everyone at once. Two consequences, both
 * handled: the per-IP limit that matters is applied below on the visitor's
 * real address, and Supabase's sign-in rate limit must be raised (runbook).
 *
 * The session is set by the server client's cookies, exactly as the browser
 * client would have stored it; the panel carries on with the MFA step and the
 * organisation check unchanged.
 */
export async function passwordSignIn(input: {
  email: string;
  password: string;
  captchaToken: string | null;
}): Promise<PasswordSignInResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return { ok: false, reason: "refused", failures: 0, waitSeconds: 0 };

  const ipGate = await checkRateLimit("sign-in-ip", clientIp(await headers()), 30, "10 m");
  if (!ipGate.allowed) return { ok: false, reason: "rate" };

  // Asked BEFORE the password is tried. Fails closed: if the gate cannot be
  // asked, no password is checked — an unanswered lock is not an open one.
  const { data: gateRows, error: gateError } = await supabaseAdmin.rpc("sign_in_gate", { p_email: email });
  if (gateError) {
    console.error("sign_in_gate failed:", gateError.message);
    return { ok: false, reason: "error" };
  }
  const gate = (gateRows as { locked: boolean; wait_seconds: number; failures: number }[] | null)?.[0];
  if (gate?.locked) return { ok: false, reason: "locked" };
  if (gate && gate.wait_seconds > 0) return { ok: false, reason: "wait", waitSeconds: gate.wait_seconds };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: input.password,
    options: input.captchaToken ? { captchaToken: input.captchaToken } : undefined,
  });

  if (!error && data.user) {
    await supabaseAdmin.rpc("clear_sign_in_failures", { p_email: email });
    return { ok: true, userId: data.user.id };
  }

  const m = (error?.message ?? "").toLowerCase();
  if (m.includes("captcha")) return { ok: false, reason: "captcha" };
  if (m.includes("rate limit") || m.includes("too many")) return { ok: false, reason: "rate" };
  if (m.includes("email not confirmed")) return { ok: false, reason: "unconfirmed" };
  if (m.includes("network") || m.includes("fetch")) return { ok: false, reason: "network" };
  // A deactivated or released account is banned at Supabase. Say what a wrong
  // password says, and count nothing: the password may well have been right.
  if (m.includes("banned")) return { ok: false, reason: "refused", failures: 0, waitSeconds: 0 };
  if (!(m.includes("invalid login") || m.includes("invalid credentials"))) {
    return { ok: false, reason: "error" };
  }

  // ── A wrong password (or an unknown email — indistinguishable, by design) ──
  const { data: rows, error: recError } = await supabaseAdmin.rpc("record_sign_in_failure", { p_email: email });
  const rec = (rows as {
    failures: number; locked: boolean; wait_seconds: number | null; notify: "warn" | "locked" | null;
    user_id: string | null; org_id: string | null; full_name: string | null; email: string | null;
  }[] | null)?.[0];
  if (recError || !rec) {
    console.error("record_sign_in_failure failed:", recError?.message);
    return { ok: false, reason: "refused", failures: 0, waitSeconds: 0 };
  }

  if (rec.locked && rec.user_id) {
    // Supabase refuses every route from here — including one that goes round
    // this screen — and no session can be refreshed. The identity functions
    // (0303) have already cut off any access token still in flight.
    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(rec.user_id, {
      ban_duration: "876000h",
    });
    if (banError) console.error("sign-in locked but the ban was refused:", banError.message);
  }

  if (rec.notify && rec.email) await tellTheOwner(rec.notify, rec);

  return rec.locked
    ? { ok: false, reason: "locked" }
    : { ok: false, reason: "refused", failures: rec.failures, waitSeconds: rec.wait_seconds ?? 0 };
}

/**
 * The only party told that THIS address is a real account is its owner, at
 * the address itself. Best-effort: a mail that cannot be sent must not change
 * what the screen says.
 */
async function tellTheOwner(
  kind: "warn" | "locked",
  rec: { user_id: string | null; org_id: string | null; full_name: string | null; email: string | null }
) {
  const name = rec.full_name ?? "there";
  const result = await sendEmail({
    to: rec.email!,
    orgId: rec.org_id,
    category: "account",
    entityType: "user",
    entityId: rec.user_id,
    subject: (ctx) =>
      kind === "warn"
        ? `${ctx.brandName} — failed sign-in attempts on your account`
        : `${ctx.brandName} — your account has been locked`,
    text: (ctx) =>
      (kind === "warn"
        ? [
            `Dear ${name},`,
            ``,
            `There have been 4 failed attempts to sign in to your ${ctx.brandName} account.`,
            `One more failed attempt will lock the account until your administrator unlocks it.`,
            ``,
            `If this was you: wait 8 minutes, then use "Forgot password?" on the sign-in page rather than guessing again.`,
            `If it was not you: tell your administrator. Your password has not been changed.`,
          ]
        : [
            `Dear ${name},`,
            ``,
            `Your ${ctx.brandName} account has been locked after 5 failed sign-in attempts.`,
            `While it is locked, it cannot be used anywhere on the portal.`,
            ``,
            `Contact your administrator. They will send a reactivation link to this address,`,
            `which you use to set a new password and sign in again.`,
            ``,
            `If the attempts were not you, say so when you contact them.`,
          ]
      ).concat([``, `${ctx.brandName}`]).join("\n"),
  });
  if (!result.sent) console.error(`sign-in ${kind} email not sent:`, result.reason);
}
