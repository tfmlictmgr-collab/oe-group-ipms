"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// The contractor's own actions on their own job (0118).
//
// Standing is decided in the database, not here: each function checks that the
// caller is the login of the vendor the job is assigned to. These wrappers
// deliberately re-implement none of that — one place decides who may act on a
// work order, and it is the same one the FM/PM path and any future automation
// go through.

export async function declineWorkOrder(
  ticketId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("decline_work_order", {
    p_ticket_id: ticketId,
    p_reason: reason,
  });
  // The function raises with a readable message (not yours, already finished,
  // reason too short) — surface it rather than a generic failure.
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard/my-work");
  return ok();
}

export async function completeWorkOrder(
  ticketId: string,
  note: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_work_order", {
    p_ticket_id: ticketId,
    p_note: note,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard/my-work");
  return ok();
}

export async function submitVendorInvoice(input: {
  amount: number;
  invoiceReference: string;
  ticketId: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_vendor_invoice", {
    p_amount: input.amount,
    p_invoice_reference: input.invoiceReference,
    p_ticket_id: input.ticketId,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/dashboard/my-work");
  revalidatePath("/dashboard/payments");
  return ok({ id: data as string });
}
