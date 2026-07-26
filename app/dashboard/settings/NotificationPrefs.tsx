"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { ChannelPicker, type ChannelPrefs } from "@/components/patterns/channel-picker";

// Personal preferences — these apply to the signed-in user only, which is why
// they save through an RPC that can only ever touch the caller's own row.
export default function NotificationPrefs({ initial }: { initial: ChannelPrefs }) {
  const router = useRouter();
  const [prefs, setPrefs] = React.useState<ChannelPrefs>(initial);
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_my_notification_prefs", {
        p_phone: prefs.phone,
        p_telegram_chat_id: prefs.telegramChatId,
        p_email: prefs.email,
        p_whatsapp: prefs.whatsapp,
        p_sms: prefs.sms,
        p_telegram: prefs.telegram,
      });
      if (error) throw new Error(error.message);
      toast.success("Notification preferences saved");
      router.refresh();
    } catch (e) {
      toast.error("Could not save preferences", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <ChannelPicker value={prefs} onChange={setPrefs} />
      <Button variant="brand" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save preferences"}
      </Button>
    </div>
  );
}
