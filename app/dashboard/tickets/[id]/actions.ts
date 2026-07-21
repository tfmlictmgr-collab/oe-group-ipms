"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Dispatch a ticket to a vendor and/or an FM ops person. Runs under the caller's
// session, so RLS restricts this to admin/FM. Sets status to 'assigned' and
// stamps who assigned it; the audit trigger records the assignment. The assignee
// is notified in-app in real time (the portal ticket list subscribes to
// postgres_changes); multi-channel delivery is layered on in the Day 13 cascade.
export async function assignTicket(
  ticketId: string,
  vendorId: string | null,
  opsUserId: string | null
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!vendorId && !opsUserId) {
    throw new Error("Pick a vendor or an ops person to assign to.");
  }

  const { error } = await supabase
    .from("tickets")
    .update({
      assigned_vendor_id: vendorId,
      assigned_to_user_id: opsUserId,
      assigned_by: user?.id ?? null,
      assigned_at: new Date().toISOString(),
      acknowledged_at: null,
      status: "assigned",
    })
    .eq("id", ticketId);
  if (error) throw new Error(error.message);

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard");
}

// The assignee acknowledges the job. RLS lets only the assigned vendor/ops user
// (or admin/FM) update this ticket, so the acknowledgement is authentic.
export async function acknowledgeJob(ticketId: string) {
  const supabase = await createClient();

  const { error } = await supabase
    .from("tickets")
    .update({
      acknowledged_at: new Date().toISOString(),
      status: "acknowledged",
    })
    .eq("id", ticketId)
    .eq("status", "assigned");
  if (error) throw new Error(error.message);

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard");
}
