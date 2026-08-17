"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { cascadeToUserIds } from "@/lib/role-notify";
import { flattenTemplateVar, firstNameTemplateVar } from "@/lib/notify";
import { shortRef } from "@/lib/acknowledgement";

// Dispatch a ticket to a vendor and/or an FM ops person. Runs under the caller's
// session, so RLS restricts this to admin/FM. Sets status to 'assigned' and
// stamps who assigned it; the audit trigger records the assignment. The assignee
// is notified in-app in real time (the portal ticket list subscribes to
// postgres_changes) AND on their own registered external channels (B8 cascade)
// — the "Day 13 cascade" this comment used to defer landed here, since a vendor
// or ops person not watching the portal was otherwise told nothing.
export async function assignTicket(
  ticketId: string,
  vendorId: string | null,
  opsUserId: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!vendorId && !opsUserId) {
    return fail("Pick a vendor or an ops person to assign this to.");
  }

  // ⚠️ `.select()` so a refused update is not reported as a dispatch. Without
  // it PostgREST returns no error and zero rows when RLS declines, the action
  // returns ok(), and the dispatcher is told "Request dispatched" while
  // nothing happened — the same silent-no-op class this build has hit before
  // in cleanup code and in removeAttachment.
  const { data: updated, error } = await supabase
    .from("tickets")
    .update({
      assigned_vendor_id: vendorId,
      assigned_to_user_id: opsUserId,
      assigned_by: user?.id ?? null,
      assigned_at: new Date().toISOString(),
      acknowledged_at: null,
      status: "assigned",
    })
    .eq("id", ticketId)
    .select("id, org_id, summary");
  if (error) return failFromDb(error, "assign this job");
  if (!updated?.length) {
    return fail(
      "That request could not be dispatched.",
      "You may not have permission to dispatch this one, or it has moved since the page was loaded."
    );
  }
  const orgId = updated[0].org_id as string;
  // job_assigned's {{2}}/{{3}} (WHATSAPP_TEMPLATES.md §1) — computed once,
  // outside the per-recipient loop, since neither varies by recipient.
  const jobSummary = flattenTemplateVar(updated[0].summary as string | null, "a new job");
  const jobRef = shortRef(ticketId);

  // ── Tell the assignee ────────────────────────────────────────────────────
  //
  // ⚠️ This used to be `if (opsUserId)` alone, so dispatching to a VENDOR
  // notified nobody — while the toast said "The assignee has been notified."
  // That is the reported symptom: a vendor given a job, told nothing. A vendor
  // is a company; the person to notify is the login attached to it, which is
  // also why a vendor with no `user_id` gets no in-app notice and must be
  // reached another way.
  const recipients: string[] = [];
  if (opsUserId) recipients.push(opsUserId);
  if (vendorId) {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("user_id")
      .eq("id", vendorId)
      .maybeSingle();
    if (vendor?.user_id) recipients.push(vendor.user_id as string);
  }

  for (const recipient of recipients) {
    await supabase.rpc("notify_user", {
      p_user_id: recipient,
      p_kind: "assignment",
      p_title: "A job has been assigned to you",
      p_body: "Open it to acknowledge and get started.",
      p_link: `/dashboard/tickets/${ticketId}`,
      p_entity_type: "ticket",
      p_entity_id: ticketId,
    });
  }

  // Same recipients, their own registered external channels (B8) — best-effort,
  // alongside rather than instead of the in-app notice above.
  try {
    await cascadeToUserIds(
      orgId,
      recipients,
      "A job has been assigned to you. Open the portal to acknowledge and get started.",
      "ticket",
      ticketId,
      // job_assigned (WHATSAPP_TEMPLATES.md §1) — {{1}} is per-recipient, so
      // this has to be a function, not a fixed template built once above.
      (r) => ({
        name: "job_assigned",
        languageCode: "en",
        variables: [firstNameTemplateVar(r.full_name), jobSummary, jobRef],
      })
    );
  } catch (e) {
    console.error("Could not send external dispatch notification:", e);
  }

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard");
  return ok();
}

// The assignee acknowledges the job. RLS lets only the assigned vendor/ops user
// (or admin/FM) update this ticket, so the acknowledgement is authentic.
export async function acknowledgeJob(ticketId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("tickets")
    .update({
      acknowledged_at: new Date().toISOString(),
      status: "acknowledged",
    })
    .eq("id", ticketId)
    .eq("status", "assigned");
  if (error) return failFromDb(error, "acknowledge this job");

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard");
  return ok();
}
