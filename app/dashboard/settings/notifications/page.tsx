import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import NotificationPrefs from "../NotificationPrefs";

// Open to every role — these are personal preferences, not org configuration.
export default async function NotificationSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: me } = await supabase
    .from("users")
    .select("phone, telegram_chat_id, notify_email, notify_whatsapp, notify_sms, notify_telegram")
    .eq("id", session.profile!.id)
    .single();

  return (
    <Card>
      <CardHeader>
        <CardTitle>My notifications</CardTitle>
        <CardDescription>
          How we reach you. These apply to your account only — they do not change
          anything for anyone else in the organisation.
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
  );
}
