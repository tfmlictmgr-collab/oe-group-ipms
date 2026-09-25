import { orgForCurrentHost } from "@/lib/org-host";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBrandTheme } from "@/lib/brands";

// Whose terms these are.
//
// Resolved from the HOST, exactly like the sign-in doors and the 404 page: on
// oeaportal.com the merchant is Ora Egbunike & Associates, on tfmlportal.com it
// is Total Facilities Management Limited, and no other organisation is named
// (B1). A payment gateway's compliance reviewer reads these on the domain the
// merchant account is registered against, so the entity named must be the one
// that owns that address. An unbound host (localhost, a preview) gets the group
// name rather than a guess.
//
// The contact address is the org's own support/finance inbox from Settings —
// never a hardcoded one, which would route one brand's refund requests to the
// other brand's desk.
export type LegalOrg = {
  name: string;
  primary: string;
  supportEmail: string | null;
  financeEmail: string | null;
};

export async function legalOrgForHost(): Promise<LegalOrg> {
  const org = await orgForCurrentHost().catch(() => null);
  if (!org || org.is_platform_operator) {
    return { name: "TENTai", primary: "#003366", supportEmail: null, financeEmail: null };
  }

  const { data } = await supabaseAdmin
    .from("orgs")
    .select("support_email, finance_email")
    .eq("id", org.id)
    .maybeSingle();

  const theme = getBrandTheme(org.delivery_brand, {
    name: org.name,
    theme_primary: org.theme_primary,
    theme_accent: org.theme_accent,
    theme_logo_text: org.theme_logo_text,
  });

  return {
    name: org.name,
    primary: theme.primary,
    supportEmail: data?.support_email?.trim() || null,
    financeEmail: data?.finance_email?.trim() || data?.support_email?.trim() || null,
  };
}
