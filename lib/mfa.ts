"use server";

import crypto from "node:crypto";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// MFA backup codes. Enrollment, the TOTP secret and the factor itself are all
// Supabase Auth's own built-in `auth.mfa_factors` — nothing to build there.
// Backup codes are not part of that API, so this is the one piece that is
// genuinely this app's own.
//
// ⚠️ A backup code does NOT sign someone in at AAL2. Supabase's AAL system is
// built entirely around TOTP challenge/verify; there is no supported way to
// tell it "this session is elevated" via some other proof without forging
// what a verified factor actually attests to. So a valid backup code instead
// DISABLES MFA for that account (deletes their factor via the admin API) and
// lets sign-in continue at AAL1 — the same shape a real authenticator-app
// loss recovery takes in most systems: the code is a "let me back in and
// re-enroll" key, not a silent TOTP substitute. The account holder is told
// this happened and prompted to re-enroll from Settings.

const CODE_COUNT = 8;
// XXXX-XXXX, base32-ish alphabet with no 0/O/1/I — nothing a person could
// misread out loud or mistype from a screenshot.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateBackupCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/**
 * (Re)generates this user's backup codes. Requires they actually hold a
 * verified TOTP factor — codes for a form of MFA that isn't on has nothing to
 * recover. Regenerating invalidates every previously issued code: showing a
 * fresh batch while old ones remain valid would mean an old screenshot never
 * really expires.
 */
export async function generateMyBackupCodes(): Promise<ActionResult<string[]>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasVerifiedTotp = (factors?.totp ?? []).some((f) => f.status === "verified");
  if (!hasVerifiedTotp) {
    return fail("Enable two-factor authentication first — backup codes are for recovering it, not a standalone option.");
  }

  const codes = Array.from({ length: CODE_COUNT }, generateBackupCode);

  await supabaseAdmin.from("mfa_backup_codes").delete().eq("user_id", user.id);
  const { error } = await supabaseAdmin.from("mfa_backup_codes").insert(
    codes.map((code) => ({ user_id: user.id, code_hash: hashBackupCode(code) }))
  );
  if (error) return fail(`Could not generate backup codes: ${error.message}`);

  return ok(codes);
}

/** Clears this user's own backup codes — called after they disable MFA
 * themselves (via the normal `mfa.unenroll` client call), so codes for a
 * factor that no longer exists don't linger. */
export async function clearMyBackupCodes(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  await supabaseAdmin.from("mfa_backup_codes").delete().eq("user_id", user.id);
  return ok();
}

/** How many of this user's backup codes are still unused — shown in Settings
 * so "I have codes" doesn't quietly mean "I have zero left." */
export async function myBackupCodeStatus(): Promise<{ total: number; remaining: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { total: 0, remaining: 0 };

  const { data } = await supabaseAdmin.from("mfa_backup_codes").select("used_at").eq("user_id", user.id);
  const rows = data ?? [];
  return { total: rows.length, remaining: rows.filter((r) => !r.used_at).length };
}

/**
 * The sign-in-time recovery path. Called from the MFA challenge step for
 * someone who has a valid AAL1 session (password already checked) but no
 * authenticator to hand. A matching, unused code disables MFA entirely for
 * this account and marks the code spent; sign-in then proceeds at AAL1.
 */
export async function verifyBackupCodeAndDisableMfa(code: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const gate = await checkRateLimit("mfa-backup-code", clientIp(await headers()), 5, "10 m");
  if (!gate.allowed) {
    return fail("Too many attempts. Please wait a few minutes and try again.");
  }

  const trimmed = (code ?? "").trim();
  if (!trimmed) return fail("Enter a backup code.");
  const hash = hashBackupCode(trimmed);

  const { data: match } = await supabaseAdmin
    .from("mfa_backup_codes")
    .select("id")
    .eq("user_id", user.id)
    .eq("code_hash", hash)
    .is("used_at", null)
    .maybeSingle();

  if (!match) {
    return fail("That backup code is invalid or has already been used.");
  }

  // Spend the code, then remove every MFA factor on the account — a partial
  // failure here must not leave the account claiming MFA is on while the one
  // way back in has already been burned.
  await supabaseAdmin.from("mfa_backup_codes").update({ used_at: new Date().toISOString() }).eq("id", match.id);

  const { data: factorList } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: user.id });
  for (const factor of factorList?.factors ?? []) {
    await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
  }
  // The rest of this account's backup codes go with it — they were only ever
  // meant to recover the factor that no longer exists.
  await supabaseAdmin.from("mfa_backup_codes").delete().eq("user_id", user.id);

  return ok();
}
