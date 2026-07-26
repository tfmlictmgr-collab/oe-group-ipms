import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getBaseTheme } from "@/lib/brands";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import SettingsForm from "./SettingsForm";
import BrandingForm from "./BrandingForm";
import ContentForm from "./ContentForm";
import NotificationPrefs from "./NotificationPrefs";
import LogoUpload from "./LogoUpload";

export default async function SettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Admin-only page (B7: admin configures approver limits/thresholds + branding).
  if (session.profile?.role !== "admin") {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Administrator access required"
          description="Only administrators can configure payment gate thresholds and portal branding."
        />
      </div>
    );
  }

  const supabase = await createClient();
  // Own row only — RLS already restricts users_select to self for non-staff,
  // and we filter by id regardless.
  const { data: me } = await supabase
    .from("users")
    .select("phone, telegram_chat_id, notify_email, notify_whatsapp, notify_sms, notify_telegram")
    .eq("id", session.profile.id)
    .single();

  const { data: settings } = await supabase
    .from("payment_settings")
    .select("min_performance_score, approval_threshold_amount")
    .eq("org_id", session.profile.org_id)
    .single();

  const { org, theme } = session;
  const defaults = getBaseTheme(org?.delivery_brand);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configure your organisation's portal branding and the vendor payment gate."
      />

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
          <LogoUpload
            orgId={session.profile.org_id}
            currentLogoUrl={theme.logoUrl}
          />
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

      <Card>
        <CardHeader>
          <CardTitle>My notifications</CardTitle>
          <CardDescription>
            How we reach you personally. These settings apply to your account
            only, not the whole organisation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationPrefs
            initial={{
              phone: me?.phone ?? "",
              telegramChatId: me?.telegram_chat_id ?? "",
              email: me?.notify_email ?? true,
              whatsapp: me?.notify_whatsapp ?? false,
              sms: me?.notify_sms ?? false,
              telegram: me?.notify_telegram ?? false,
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment gate</CardTitle>
          <CardDescription>
            Admin-configurable thresholds for the B4 vendor payment gate. Payments
            above the approval limit require an administrator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            orgId={session.profile.org_id}
            initialMinScore={Number(settings?.min_performance_score ?? 70)}
            initialThreshold={Number(settings?.approval_threshold_amount ?? 1000000)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
