import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, ChevronDown } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { roleLabel } from "@/lib/roles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ProfileForm from "./ProfileForm";
import NotificationPrefs from "../NotificationPrefs";

// Where a non-administrator lands in Settings.
//
// The section index is the branding page, which is administrator-only, so
// everyone else used to arrive at "Administrator access required" — following a
// welcome notification that had just told them they could change how they are
// reached. `/dashboard/settings` now redirects here instead.
//
// Open to every role by design: this is a person's own account, not
// organisation configuration. What they may change is decided in
// `update_my_profile` (0135), not here.

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: me } = await supabase
    .from("users")
    .select("full_name, email, notify_email, notify_whatsapp, notify_sms, notify_telegram, phone, telegram_chat_id")
    .eq("id", session.profile!.id)
    .single();

  // The person's own consent history (0148). Read through `my_channel_consents`,
  // which is scoped to auth.uid() — the table itself grants nothing to a client
  // beyond the caller's own rows. Only the LATEST row per channel decides the
  // current state; a withdrawal is a newer row, never an edit of the grant.
  const { data: consentRows } = await supabase.rpc("my_channel_consents");
  const latestByChannel = new Map<string, string>();
  for (const r of (consentRows ?? []) as { channel: string; action: string }[]) {
    // Rows arrive newest-first, so the first sighting of a channel is current.
    if (!latestByChannel.has(r.channel)) latestByChannel.set(r.channel, r.action);
  }
  const consented = (["whatsapp", "telegram", "sms"] as const).filter(
    (c) => latestByChannel.get(c) === "granted"
  );

  const role = session.profile?.role ?? "member";
  const channels = [
    me?.notify_email && "email",
    me?.notify_whatsapp && "WhatsApp",
    me?.notify_sms && "SMS",
    me?.notify_telegram && "Telegram",
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>My profile</CardTitle>
          <CardDescription>
            Your own account. Nothing here changes anything for anyone else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            initial={{ fullName: me?.full_name ?? "" }}
            email={me?.email ?? session.user.email ?? "—"}
            roleLabel={roleLabel(role, session.org?.delivery_brand)}
            orgName={session.org?.name ?? "—"}
          />
        </CardContent>
      </Card>

      {/* ⚠️ Collapsed by default, and that is the point.
          "How should we reach you" is set once and rarely revisited; putting
          the form here in full would bury the profile fields under it. It sits
          open when nothing is configured, because a person who has switched no
          channel on is exactly the one who needs to see it. */}
      <Card>
        <CardContent className="p-0">
          <details open={channels.length <= 1 && !me?.phone}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5 [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-medium">
                  <Bell className="size-4 text-muted-foreground" /> How we reach you
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {channels.length > 0
                    ? `Currently by ${channels.join(", ")}${me?.phone ? "" : " — no phone number on file, so WhatsApp and SMS cannot be used"}.`
                    : "No channels are switched on, so you will only see notifications in the portal."}
                </span>
              </span>
              <ChevronDown className="size-4 flex-shrink-0 text-muted-foreground transition-transform [details[open]_&]:rotate-180" />
            </summary>
            <div className="border-t border-border p-4 sm:p-5">
              <NotificationPrefs
                consented={consented}
                initial={{
                  phone: me?.phone ?? "",
                  telegramChatId: me?.telegram_chat_id ?? "",
                  email: me?.notify_email ?? true,
                  whatsapp: me?.notify_whatsapp ?? false,
                  sms: me?.notify_sms ?? false,
                  telegram: me?.notify_telegram ?? false,
                }}
              />
              <p className="mt-4 text-xs text-muted-foreground">
                Looking for what has actually happened?{" "}
                <Link href="/dashboard/settings/notifications" className="underline underline-offset-2">
                  My Notifications
                </Link>{" "}
                is your inbox.
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

    </div>
  );
}
