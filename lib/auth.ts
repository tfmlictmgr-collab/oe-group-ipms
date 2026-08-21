import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getBrandTheme } from "@/lib/brands";

// Loads the logged-in user's profile row + org (both RLS-scoped to self).
// Returns null if there's no session.
//
// ⚠️ Wrapped in React's `cache` so the three queries below run ONCE per
// request no matter how many callers ask. The dashboard layout needs this to
// render the shell, and its `generateMetadata` needs the same org to title
// the browser tab — two calls in one render pass. Without deduping, every
// dashboard page load would pay for a doubled auth + profile + org round
// trip, on the entry path of the whole product.
export const getSessionProfile = cache(async function getSessionProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("users")
    // `approval_tier` travels with the profile because it is half of what
    // decides whether a person may action a stage — role alone cannot answer
    // it (0151). Without it here, a payment_approver would be shown a stage
    // they hold the role for and then be refused on the tier.
    .select("id, role, approval_tier, full_name, email, org_id")
    .eq("id", user.id)
    .single();

  const { data: org } = await supabase
    .from("orgs")
    .select(
      "id, name, delivery_brand, is_platform_operator, theme_primary, theme_accent, theme_logo_text, logo_url, portal_name, tagline, support_email, support_phone, whatsapp_number, telegram_bot_username, login_headline, finance_email, it_email, email_from_name, email_from_address"
    )
    .eq("id", profile?.org_id)
    .single();

  return {
    user,
    profile,
    org,
    theme: getBrandTheme(org?.delivery_brand, org),
  };
});
