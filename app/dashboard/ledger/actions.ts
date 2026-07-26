"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { validateStatementCsv } from "@/lib/statement-import";

// Every call runs under the caller's own session, so the finance/admin RLS
// policies and the ledger's invariant triggers apply exactly as they would to a
// direct API call. Nothing here uses the service role.

async function financeContext() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    throw new Error("Only finance or an administrator can work with the ledger.");
  }
  return { supabase, orgId: me.org_id as string, userId: user.id };
}

/** Bank references already held, so the preview can flag re-imports. */
export async function existingStatementRefs(bankAccountId: string): Promise<string[]> {
  const { supabase } = await financeContext();
  const { data } = await supabase
    .from("bank_statement_lines")
    .select("external_id")
    .eq("bank_account_id", bankAccountId)
    .not("external_id", "is", null);
  return (data ?? []).map((r) => String(r.external_id).toLowerCase());
}

/**
 * Commits a statement import. Re-validates server-side rather than trusting the
 * browser's preview: the client could have been tampered with, and lines may
 * have been imported by someone else since the preview was generated.
 */
export async function commitStatementImport(
  bankAccountId: string,
  csvText: string
): Promise<{ imported: number; skipped: number }> {
  const { supabase, orgId, userId } = await financeContext();

  const { data: bank } = await supabase
    .from("bank_accounts").select("id").eq("id", bankAccountId).single();
  if (!bank) throw new Error("Bank account not found.");

  const existing = new Set(await existingStatementRefs(bankAccountId));
  const { rows } = validateStatementCsv(csvText, existing);

  const usable = rows.filter((r) => r.valid && r.values);
  if (usable.length === 0) {
    return { imported: 0, skipped: rows.length };
  }

  const batchId = crypto.randomUUID();
  const { data, error } = await supabase
    .from("bank_statement_lines")
    .insert(
      usable.map((r) => ({
        org_id: orgId,
        bank_account_id: bankAccountId,
        import_batch_id: batchId,
        imported_by: userId,
        ...r.values!,
      }))
    )
    .select("id");

  if (error) throw new Error(error.message);

  revalidatePath("/dashboard/ledger/reconciliation");
  return { imported: data?.length ?? 0, skipped: rows.length - usable.length };
}

/** Suggests matches. Conservative: ambiguous lines are left for a person. */
export async function autoMatch(bankAccountId: string): Promise<number> {
  const { supabase } = await financeContext();
  const { data, error } = await supabase.rpc("auto_match_statement_lines", {
    p_bank_account_id: bankAccountId,
    p_day_window: 3,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ledger/reconciliation");
  return Number(data ?? 0);
}

export type ReconciliationResult = {
  ledger_balance: number;
  statement_balance: number;
  variance: number;
  matched_lines: number;
  unmatched_lines: number;
  status: "balanced" | "variance";
};

export async function runReconciliation(
  bankAccountId: string,
  asOfDate: string
): Promise<ReconciliationResult> {
  const { supabase } = await financeContext();
  const { data, error } = await supabase.rpc("run_reconciliation", {
    p_bank_account_id: bankAccountId,
    p_as_of_date: asOfDate,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath("/dashboard/ledger/reconciliation");
  return row as ReconciliationResult;
}

/** Marks a line as not needing a ledger counterpart (e.g. a duplicate row). */
export async function ignoreStatementLine(lineId: string) {
  const { supabase } = await financeContext();
  const { error } = await supabase
    .from("bank_statement_lines")
    .update({ status: "ignored" })
    .eq("id", lineId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ledger/reconciliation");
}
