"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, failFromDb, type ActionResult } from "@/lib/action-result";

// The four ledger movements finance could not record before 0320. Each calls a
// narrow SECURITY DEFINER function under the caller's own session; the function
// decides who may (the Payment Officer or the Payment Approver), validates the
// figures and writes one balanced, immutable entry. Nothing here uses the
// service role, and nothing here decides access.

function refresh() {
  for (const p of ["/dashboard/ledger", "/dashboard/ledger/journal", "/dashboard/ledger/reconciliation", "/dashboard/ledger/reports"]) {
    revalidatePath(p);
  }
}

export async function recordGatewaySettlement(input: {
  bankAccountId: string; gateway: "paystack" | "flutterwave"; settledOn: string; gross: number; fees: number; reference: string;
}): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_gateway_settlement", {
    p_bank_account_id: input.bankAccountId, p_gateway: input.gateway, p_settled_on: input.settledOn,
    p_gross: input.gross, p_fees: input.fees, p_reference: input.reference,
  });
  if (error) return failFromDb(error, "record the settlement");
  refresh();
  return ok(data as string);
}

export async function recordGatewayTopup(input: {
  bankAccountId: string; gateway: "paystack" | "flutterwave"; on: string; amount: number; reference: string;
}): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_gateway_topup", {
    p_bank_account_id: input.bankAccountId, p_gateway: input.gateway, p_on: input.on, p_amount: input.amount, p_reference: input.reference,
  });
  if (error) return failFromDb(error, "record the top-up");
  refresh();
  return ok(data as string);
}

export async function recordBankCharge(input: {
  bankAccountId: string; on: string; amount: number; reason: string; reference: string;
}): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_bank_charge", {
    p_bank_account_id: input.bankAccountId, p_on: input.on, p_amount: input.amount, p_reason: input.reason, p_reference: input.reference || null,
  });
  if (error) return failFromDb(error, "record the bank charge");
  refresh();
  return ok(data as string);
}

export async function fundOverdrawnAccount(input: {
  accountId: string; bankAccountId: string; on: string; amount: number; reference: string; reason: string;
}): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fund_overdrawn_account", {
    p_account_id: input.accountId, p_bank_account_id: input.bankAccountId, p_on: input.on,
    p_amount: input.amount, p_reference: input.reference, p_reason: input.reason,
  });
  if (error) return failFromDb(error, "fund the account");
  refresh();
  return ok(data as string);
}
