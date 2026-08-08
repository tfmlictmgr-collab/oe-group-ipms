import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { getBaseTheme } from "@/lib/brands";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import BrandingForm from "./BrandingForm";
import ContentForm from "./ContentForm";
import LogoUpload from "./LogoUpload";

export default async function BrandingSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // ⚠️ A non-admin is SENT to their own settings, not refused on this one.
  //
  // Reported from production: the welcome notification tells every new user
  // "You can change how we reach you in Settings", and a tenant following that
  // sentence landed here — on the branding page, which is administrator-only —
  // and was told "Administrator access required". Their preferences were one
  // unlabelled tab away and working perfectly, but the page they were sent to
  // said no, so the reasonable conclusion was that Settings held nothing for
  // them.
  //
  // The section index has to be something the visitor can USE. `AdminOnly`
  // stays for anyone who types an admin sub-route directly — a refusal is right
  // when the user chose that page; it is wrong when the product chose it for
  // them.
  if (session.profile?.role !== "admin") redirect("/dashboard/settings/profile");

  const { org, theme } = session;
  const defaults = getBaseTheme(org?.delivery_brand);

  return (
    <div className="space-y-4">
      <BrandingForm
        orgId={session.profile.org_id}
        initial={{
          name: org?.name ?? theme.name,
          primary: theme.primary,
          accent: theme.accent,
          logoText: theme.logoText ?? "",
        }}
        defaults={{
          name: defaults.name,
          primary: defaults.primary,
          accent: defaults.accent,
          logoText: defaults.logoText ?? "",
        }}
        logoSlot={
          <LogoUpload orgId={session.profile.org_id} currentLogoUrl={theme.logoUrl} />
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Portal text</CardTitle>
          <CardDescription>
            Rename the portal and set the copy your people see — no code required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContentForm
            orgId={session.profile.org_id}
            initial={{
              portalName: org?.portal_name ?? "",
              tagline: org?.tagline ?? "",
              supportEmail: org?.support_email ?? "",
              supportPhone: org?.support_phone ?? "",
              financeEmail: org?.finance_email ?? "",
              itEmail: org?.it_email ?? "",
              emailFromName: org?.email_from_name ?? "",
              emailFromAddress: org?.email_from_address ?? "",
            }}
            placeholders={{ portalName: defaults.portalName }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
