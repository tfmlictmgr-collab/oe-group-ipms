"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Admin-configurable payment gate thresholds (B7: admin configures limits).
// RLS restricts writes to admins; this action just passes the values through.
export async function updatePaymentSettings(
  orgId: string,
  minPerformanceScore: number,
  approvalThresholdAmount: number
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("payment_settings").upsert({
    org_id: orgId,
    min_performance_score: minPerformanceScore,
    approval_threshold_amount: approvalThresholdAmount,
    updated_at: new Date().toISOString(),
  });
  if (error) return failFromDb(error, "save these payment settings");
  revalidatePath("/dashboard/settings");
  return ok();
}

// Per-org branding. RLS (orgs_admin_update) restricts writes to the caller's own
// org and to admins; this action additionally validates the values and touches
// ONLY the theme columns + display name, so no other org field can be edited
// through this path. Empty/blank values clear the override and fall back to the
// delivery_brand defaults in lib/brands.ts.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function updateOrgBranding(
  orgId: string,
  input: { name: string; primary: string; accent: string; logoText: string }
): Promise<ActionResult> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    return fail("Organisation name must be between 2 and 80 characters.");
  }
  const primary = input.primary.trim();
  const accent = input.accent.trim();
  if (primary && !HEX.test(primary)) {
    return fail("Primary colour must be a hex value like #8B1D1D.");
  }
  if (accent && !HEX.test(accent)) {
    return fail("Accent colour must be a hex value like #C9A227.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("orgs")
    .update({
      name,
      theme_primary: primary || null,
      theme_accent: accent || null,
      theme_logo_text: input.logoText.trim().slice(0, 2) || null,
    })
    .eq("id", orgId);

  if (error) return failFromDb(error, "save your branding");
  // The shell reads the theme on every dashboard route → revalidate the subtree.
  revalidatePath("/dashboard", "layout");
  return ok();
}

// Records the uploaded logo's public URL (or clears it). The file itself is
// uploaded client-side straight to Storage, where bucket policies already
// restrict writes to the org's own prefix and to admins. We re-validate here
// that the URL is one of ours, so a crafted value can't point the <img> at a
// third-party host. Pass null to remove.
export async function saveLogoUrl(
  orgId: string,
  url: string | null
): Promise<ActionResult> {
  let value: string | null = null;
  if (url) {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const prefix = `${base}/storage/v1/object/public/org-logos/${orgId}/`;
    if (!base || !url.startsWith(prefix)) {
      return fail("That logo could not be accepted — it must be a file uploaded to this organisation.");
    }
    value = url;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("orgs").update({ logo_url: value }).eq("id", orgId);
  if (error) return failFromDb(error, "save your logo");
  revalidatePath("/dashboard", "layout");
  return ok();
}

// Editable portal copy: what the portal is called, its tagline, the login
// headline, and support contacts. All optional — blank clears back to default.
export async function updateOrgContent(
  orgId: string,
  input: {
    portalName: string;
    tagline: string;
    supportEmail: string;
    supportPhone: string;
    financeEmail: string;
    itEmail: string;
    emailFromName: string;
    emailFromAddress: string;
  }
): Promise<ActionResult> {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const email = input.supportEmail.trim();
  const financeEmail = input.financeEmail.trim();
  const itEmail = input.itEmail.trim();
  for (const [label, v] of [
    ["Support", email],
    ["Finance", financeEmail],
    ["IT", itEmail],
    ["Sending", input.emailFromAddress.trim()],
  ] as const) {
    if (v && !EMAIL_RE.test(v)) return fail(`${label} email is not a valid address.`);
  }

  // Length overruns are collected rather than thrown, so the whole form can be
  // reported at once instead of one field per attempt.
  const tooLong: string[] = [];
  const limit = (label: string, value: string, n: number) => {
    const v = value.trim();
    if (v.length > n) tooLong.push(`${label} (max ${n} characters)`);
    return v.slice(0, n) || null;
  };

  const supabase = await createClient();
  const update = {
      portal_name: limit("Portal name", input.portalName, 40),
      tagline: limit("Tagline", input.tagline, 120),
      support_email: email || null,
      support_phone: limit("Support phone", input.supportPhone, 40),
      finance_email: financeEmail || null,
      it_email: itEmail || null,
      email_from_name: limit("Sender name", input.emailFromName, 60),
      email_from_address: input.emailFromAddress.trim() || null,
  };

  if (tooLong.length > 0) {
    return fail(`Too long: ${tooLong.join(", ")}.`, "Shorten those and save again.");
  }

  const { error } = await supabase.from("orgs").update(update).eq("id", orgId);
  if (error) return failFromDb(error, "save your portal details");
  revalidatePath("/dashboard", "layout");
  return ok();
}
