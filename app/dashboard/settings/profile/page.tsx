import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ProfileForm from "./ProfileForm";

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
    .select("full_name, email, notify_email, notify_whatsapp, notify_sms, notify_telegram, phone")
    .eq("id", session.profile!.id)
    .single();

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

      {/* The sentence the welcome notification actually promises, made into a
          link. Someone arriving here from that message is looking for exactly
          this, and should not have to find it in a tab strip. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How we reach you</CardTitle>
          <CardDescription>
            {channels.length > 0
              ? `Currently by ${channels.join(", ")}${me?.phone ? "" : " — no phone number on file, so WhatsApp and SMS cannot be used"}.`
              : "No channels are switched on, so you will only see notifications in the portal."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/dashboard/settings/notifications">
              <Bell /> Change my notification channels
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
