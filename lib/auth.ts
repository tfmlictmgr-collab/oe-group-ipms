import { createClient } from "@/lib/supabase/server";
import { getBrandTheme } from "@/lib/brands";

// Loads the logged-in user's profile row + org (both RLS-scoped to self).
// Returns null if there's no session.
export async function getSessionProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("users")
    .select("id, role, full_name, email, org_id")
    .eq("id", user.id)
    .single();

  const { data: org } = await supabase
    .from("orgs")
    .select("id, name, delivery_brand")
    .eq("id", profile?.org_id)
    .single();

  return {
    user,
    profile,
    org,
    theme: getBrandTheme(org?.delivery_brand),
  };
}
