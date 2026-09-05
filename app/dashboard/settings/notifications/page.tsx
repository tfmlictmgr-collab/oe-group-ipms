import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import NotificationInbox, { type InboxRow } from "./NotificationInbox";

// The tab is now the INBOX, not the settings form.
//
// The channel preferences moved to a collapsible section on My Profile, where
// they belong: "how do you want to be reached" is set once and rarely revisited,
// while "what has happened that needs me" is the thing a person opens this for.
// Handing them a settings form under a heading called "My Notifications" made
// the tab useless for the second question.
//
// Read through `my_notifications()` (0145): the caller's own rows, everything
// from the last 30 days plus anything still unread whatever its age, and
// `target_live` per row so a dead link is never offered as one.

export const dynamic = "force-dynamic";

export default async function NotificationInboxPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase.rpc("my_notifications", { p_days: 30 });

  return <NotificationInbox rows={(data ?? []) as InboxRow[]} />;
}
