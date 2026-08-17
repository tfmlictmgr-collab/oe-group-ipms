"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Raising an FM/PM ops requisition, and verifying a one-off line payee.
//
// Both call server-role-agnostic database functions that already carry the
// real authority checks (0170, 0172) — this layer exists for the same reason
// every other action file in this codebase says it does: a sentence a person
// can act on, not the control itself.

export type RequisitionLineInput = {
  description: string;
  amount: number;
  vendorId?: string | null;
};

export async function raiseRequisition(input: {
  reference: string;
  ticketId?: string | null;
  attachmentPath?: string | null;
  lines: RequisitionLineInput[];
}): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  if (input.lines.length === 0) {
    return fail("Add at least one cost line before submitting.");
  }
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (l.description.trim().length < 3) {
      return fail(`Line ${i + 1}: describe the cost in at least 3 characters.`);
    }
    if (!Number.isFinite(l.amount) || l.amount <= 0) {
      return fail(`Line ${i + 1}: enter a positive amount.`);
    }
  }

  const { data, error } = await supabase.rpc("raise_ops_requisition", {
    p_reference: input.reference,
    p_ticket_id: input.ticketId || null,
    p_attachment_path: input.attachmentPath || null,
    p_lines: input.lines.map((l) => ({
      description: l.description.trim(),
      amount: l.amount,
      vendorId: l.vendorId || null,
    })),
  });
  if (error) return failFromDb(error, "raise this requisition");

  revalidatePath("/dashboard/approvals");
  if (input.ticketId) revalidatePath(`/dashboard/tickets/${input.ticketId}`);
  return ok({ id: data as string });
}

/**
 * Verifies a one-off/staff payee's bank account through the gateway (the
 * same name-match call a vendor's own bank details already go through) and
 * records the result against a requisition line.
 *
 * The account number is sent to the gateway and never stored — only the
 * recipient code that comes back, exactly the discipline
 * `saveVendorPayoutRecipient` already applies.
 */
export async function saveRequisitionLinePayee(input: {
  lineId: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
}): Promise<ActionResult<{ resolvedName: string; last4: string; nameMatches: boolean }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const accountNumber = input.accountNumber.replace(/\s/g, "");
  if (!/^\d{10}$/.test(accountNumber)) {
    return fail("A Nigerian account number is 10 digits.");
  }
  if (!/^\d{3,6}$/.test(input.bankCode.trim())) {
    return fail("Choose the payee's bank.");
  }

  const { getGateway } = await import("@/lib/gateway");
  const gateway = getGateway("NGN");

  const created = await gateway.createRecipient({
    name: input.accountName.trim(),
    accountNumber,
    bankCode: input.bankCode.trim(),
    currency: "NGN",
  });
  if (!created.ok || !created.recipientCode) {
    return fail(
      `The bank could not confirm that account: ${created.error ?? "no reason given"}`,
      "Check the account number and the bank. Nothing has been saved."
    );
  }

  const resolvedName = created.resolvedName ?? input.accountName.trim();
  const last4 = accountNumber.slice(-4);

  const { error } = await supabase.rpc("save_requisition_line_payee", {
    p_line_id: input.lineId,
    p_display_name: resolvedName,
    p_account_name: resolvedName,
    p_account_number_last4: last4,
    p_recipient_code: created.recipientCode,
    p_gateway: gateway.name === "simulated" ? "paystack" : gateway.name,
  });
  if (error) return failFromDb(error, "save this payee's bank details");

  revalidatePath("/dashboard/approvals");
  return ok({
    resolvedName,
    last4,
    nameMatches: resolvedName.trim().toLowerCase() === input.accountName.trim().toLowerCase(),
  });
}
