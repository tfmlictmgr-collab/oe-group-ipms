"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Admin-configurable payment gate thresholds (B7: admin configures limits).
// RLS restricts writes to admins; this action just passes the values through.
export async function updatePaymentSettings(
  orgId: string,
  minPerformanceScore: number,
  approvalThresholdAmount: number
) {
  const supabase = await createClient();
  const { error } = await supabase.from("payment_settings").upsert({
    org_id: orgId,
    min_performance_score: minPerformanceScore,
    approval_threshold_amount: approvalThresholdAmount,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
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
) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new Error("Organisation name must be between 2 and 80 characters.");
  }
  const primary = input.primary.trim();
  const accent = input.accent.trim();
  if (primary && !HEX.test(primary)) {
    throw new Error("Primary colour must be a hex value like #8B1D1D.");
  }
  if (accent && !HEX.test(accent)) {
    throw new Error("Accent colour must be a hex value like #C9A227.");
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

  if (error) throw new Error(error.message);
  // The shell reads the theme on every dashboard route → revalidate the subtree.
  revalidatePath("/dashboard", "layout");
}

// Records the uploaded logo's public URL (or clears it). The file itself is
// uploaded client-side straight to Storage, where bucket policies already
// restrict writes to the org's own prefix and to admins. We re-validate here
// that the URL is one of ours, so a crafted value can't point the <img> at a
// third-party host. Pass null to remove.
export async function saveLogoUrl(orgId: string, url: string | null) {
  let value: string | null = null;
  if (url) {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const prefix = `${base}/storage/v1/object/public/org-logos/${orgId}/`;
    if (!base || !url.startsWith(prefix)) {
      throw new Error("Rejected logo URL — it must be an uploaded file for this organisation.");
    }
    value = url;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("orgs").update({ logo_url: value }).eq("id", orgId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard", "layout");
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
  }
) {
  const email = input.supportEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Support email is not a valid address.");
  }
  const limit = (s: string, n: number) => {
    const v = s.trim();
    if (v.length > n) throw new Error(`Value too long (max ${n} characters).`);
    return v || null;
  };

  const supabase = await createClient();
  const { error } = await supabase
    .from("orgs")
    .update({
      portal_name: limit(input.portalName, 40),
      tagline: limit(input.tagline, 120),
      support_email: email || null,
      support_phone: limit(input.supportPhone, 40),
    })
    .eq("id", orgId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard", "layout");
}
