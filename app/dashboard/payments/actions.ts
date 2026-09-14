"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";

export type BatchOutcome = {
  paymentId: string;
  approved: boolean;
  reason: string | null;
};

export type BatchResult = {
  outcomes: BatchOutcome[];
  approved: number;
  refused: number;
};

/**
 * Approves several vendor invoices in one action.
 *
 * ⚠️ The gate is NOT re-implemented here, and this action deliberately does
 * almost nothing. `approve_payments` (0127) is SECURITY INVOKER, so every row
 * still passes RLS and `enforce_payment_transition` individually — the batch is
 * N single approvals, not a privileged path that happens to do N things. What
 * this layer adds is the ledger recognition afterwards, which the single-payment
 * path also does and for the same reason.
 *
 * Partial success is the normal case, not an error. A week's invoices will
 * routinely contain one above the caller's threshold, and the honest answer is
 * "eighteen approved, two need an administrator" — not a failed action with
 * nothing done.
 */
export async function approvePayments(ids: string[]): Promise<ActionResult<BatchResult>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  if (!ids.length) return fail("Select at least one invoice to approve.");

  const { data, error } = await supabase.rpc("approve_payments", { p_ids: ids });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  const outcomes: BatchOutcome[] = (data ?? []).map(
    (r: { payment_id: string; approved: boolean; reason: string | null }) => ({
      paymentId: r.payment_id,
      approved: r.approved,
      reason: r.reason,
    })
  );

  // Approving IS the moment the obligation arises, so that is when it enters
  // the books (0042). Idempotent, and deliberately not fatal — an approval that
  // has been recorded must not be undone because a ledger posting failed; the
  // remittance path recognises it again before paying anything out. Same
  // reasoning as the single-payment action, and it must stay the same: a batch
  // that skipped this would leave a payable off the books that the one-at-a-time
  // route records.
  const approvedIds = outcomes.filter((o) => o.approved).map((o) => o.paymentId);
  if (approvedIds.length) {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    for (const id of approvedIds) {
      const { error: payableErr } = await supabaseAdmin.rpc("recognise_vendor_payable", {
        p_payment_id: id,
      });
      if (payableErr) {
        console.error("could not recognise vendor payable for", id, "-", payableErr.message);
      }
    }
  }

  revalidatePath("/dashboard/payments");
  revalidatePath("/dashboard/ledger");

  return ok({
    outcomes,
    approved: approvedIds.length,
    refused: outcomes.length - approvedIds.length,
  });
}
