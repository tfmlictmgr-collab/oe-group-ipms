"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Marks every unread notification of the CALLER as read.
 *
 * No user id is passed and none is accepted: `user_notifications`'s update
 * policy is scoped to `user_id = auth.uid()`, so this can only ever touch the
 * caller's own inbox. Taking an id here would create a parameter that looks
 * like it should work on someone else's.
 */
export async function markAllNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  await supabase
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);

  revalidatePath("/dashboard/settings/notifications");
  revalidatePath("/dashboard");
}
