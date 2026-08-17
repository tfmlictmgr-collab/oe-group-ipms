"use server";

import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/action-result";
import { checkRateLimit, REMITTANCE_LIMIT } from "@/lib/rate-limit";
import type { RemittanceOutcome } from "@/lib/remittance-run";

type Guard = { ok: true; userId: string } | RemittanceOutcome;

// Disbursing a cleared requisition, per payee — one call settles every
// not-yet-remitted line naming that vendor or that verified one-off payee
// (create_requisition_vendor_remittance / create_requisition_payee_remittance,
// 0173), then the same claim → transfer → post pipeline every other outbound
// payment in this codebase already goes through (lib/remittance-run.ts).

async function guard(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || me.role !== "finance_approver") {
    return fail(
      "Only a finance approver can send a payment.",
      "Oversight authorises; finance disburses."
    );
  }

  const gate = await checkRateLimit(
    "remittance-execute", user.id, REMITTANCE_LIMIT.limit, REMITTANCE_LIMIT.window
  );
  if (gate.degraded) {
    return fail(
      "The abuse-protection check for payments is currently unavailable.",
      "Nothing has been sent. Try again shortly."
    );
  }
  if (!gate.allowed) {
    return fail(
      "Too many payments sent in a short window.",
      "Wait a few minutes and try again — this protects against a runaway or compromised session."
    );
  }
  return { ok: true, userId: user.id };
}

export async function sendRequisitionVendorLines(
  requisitionId: string,
  vendorId: string
): Promise<RemittanceOutcome> {
  const g = await guard();
  if (!("userId" in g)) return g;

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { newPaymentReference } = await import("@/lib/gateway");
  const reference = newPaymentReference("requisition");

  const { data: remittanceId, error } = await supabaseAdmin.rpc(
    "create_requisition_vendor_remittance",
    { p_requisition_id: requisitionId, p_vendor_id: vendorId, p_reference: reference, p_executed_by: g.userId }
  );
  if (error) {
    return fail(error.message.replace(/^.*?:\s*/, ""), "Nothing has been sent.");
  }

  const { sendCreatedRemittance } = await import("@/lib/remittance-run");
  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    sentBy: g.userId,
    reasonFor: (name, ref) => `Requisition ${ref} — ${name}`,
    revalidate: [`/dashboard/approvals/requisitions/${requisitionId}`, "/dashboard/approvals", "/dashboard/ledger"],
  });
}

export async function sendRequisitionPayeeLines(
  requisitionId: string,
  payeeRecipientId: string
): Promise<RemittanceOutcome> {
  const g = await guard();
  if (!("userId" in g)) return g;

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { newPaymentReference } = await import("@/lib/gateway");
  const reference = newPaymentReference("requisition");

  const { data: remittanceId, error } = await supabaseAdmin.rpc(
    "create_requisition_payee_remittance",
    { p_requisition_id: requisitionId, p_payee_recipient_id: payeeRecipientId, p_reference: reference, p_executed_by: g.userId }
  );
  if (error) {
    return fail(error.message.replace(/^.*?:\s*/, ""), "Nothing has been sent.");
  }

  const { sendCreatedRemittance } = await import("@/lib/remittance-run");
  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    sentBy: g.userId,
    reasonFor: (name, ref) => `Requisition ${ref} — ${name}`,
    revalidate: [`/dashboard/approvals/requisitions/${requisitionId}`, "/dashboard/approvals", "/dashboard/ledger"],
  });
}
