"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { validateStatementCsv } from "@/lib/statement-import";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Every call runs under the caller's own session, so the finance/admin RLS
// policies and the ledger's invariant triggers apply exactly as they would to a
// direct API call. Nothing here uses the service role.

type FinanceContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  orgId: string;
  userId: string;
};

/** Returns the context, or the refusal to hand straight back to the caller. */
async function financeContext(): Promise<
  { ctx: FinanceContext; denied?: undefined } | { ctx?: undefined; denied: ActionResult<never> }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { denied: fail("Your session expired. Please sign in again.") };
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return { denied: fail("Only finance or an administrator can work with the ledger.") };
  }
  return { ctx: { supabase, orgId: me.org_id as string, userId: user.id } };
}

/** Bank references already held, so the preview can flag re-imports. */
export async function existingStatementRefs(
  bankAccountId: string
): Promise<ActionResult<string[]>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;
  const { supabase } = ctx;
  const { data } = await supabase
    .from("bank_statement_lines")
    .select("external_id")
    .eq("bank_account_id", bankAccountId)
    .not("external_id", "is", null);
  return ok((data ?? []).map((r) => String(r.external_id).toLowerCase()));
}

/**
 * Commits a statement import. Re-validates server-side rather than trusting the
 * browser's preview: the client could have been tampered with, and lines may
 * have been imported by someone else since the preview was generated.
 */
export async function commitStatementImport(
  bankAccountId: string,
  csvText: string
): Promise<ActionResult<{ imported: number; skipped: number }>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;
  const { supabase, orgId, userId } = ctx;

  const { data: bank } = await supabase
    .from("bank_accounts").select("id").eq("id", bankAccountId).single();
  if (!bank) return fail("That bank account could not be found.");

  const refs = await existingStatementRefs(bankAccountId);
  if (!refs.ok) return refs;
  const existing = new Set(refs.data);
  const { rows } = validateStatementCsv(csvText, existing);

  const usable = rows.filter((r) => r.valid && r.values);
  if (usable.length === 0) {
    return ok({ imported: 0, skipped: rows.length });
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

  if (error) return failFromDb(error, "import these statement lines");

  revalidatePath("/dashboard/ledger/reconciliation");
  return ok({ imported: data?.length ?? 0, skipped: rows.length - usable.length });
}

/** Suggests matches. Conservative: ambiguous lines are left for a person. */
export async function autoMatch(bankAccountId: string): Promise<ActionResult<number>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;
  const { data, error } = await ctx.supabase.rpc("auto_match_statement_lines", {
    p_bank_account_id: bankAccountId,
    p_day_window: 3,
  });
  if (error) return failFromDb(error, "match these statement lines");
  revalidatePath("/dashboard/ledger/reconciliation");
  return ok(Number(data ?? 0));
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
): Promise<ActionResult<ReconciliationResult>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;
  const { data, error } = await ctx.supabase.rpc("run_reconciliation", {
    p_bank_account_id: bankAccountId,
    p_as_of_date: asOfDate,
  });
  if (error) return failFromDb(error, "run the reconciliation");
  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath("/dashboard/ledger/reconciliation");
  return ok(row as ReconciliationResult);
}

/** Marks a line as not needing a ledger counterpart (e.g. a duplicate row). */
export async function ignoreStatementLine(lineId: string): Promise<ActionResult> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;
  const { error } = await ctx.supabase
    .from("bank_statement_lines")
    .update({ status: "ignored" })
    .eq("id", lineId);
  if (error) return failFromDb(error, "ignore this statement line");
  revalidatePath("/dashboard/ledger/reconciliation");
  return ok();
}

/**
 * Remittances that need a person.
 *
 * A transfer can succeed at the gateway and then fail to post to the ledger —
 * a missing account, a constraint, a transient database fault. The money HAS
 * left, so retrying the transfer is the one thing that must never happen; what
 * is needed is to complete the posting. Until now the only recovery was the
 * gateway re-delivering its webhook, which never comes if the cause is
 * persistent, and the failure lived in a server log nobody reads.
 *
 * `sending`  — instructed, never confirmed.
 * `unknown`  — the gateway was unreachable mid-instruction; it may or may not
 *              have gone. This one is genuinely ambiguous and must be checked
 *              at the gateway before anything is done.
 *
 * Only rows older than the grace period are returned: a remittance sent five
 * seconds ago is in flight, not stuck.
 */
export type StuckRemittance = {
  id: string;
  reference: string;
  party: string;
  status: string;
  net_amount: number | string;
  transfer_code: string | null;
  gateway_message: string | null;
  created_at: string;
};

const STUCK_AFTER_MINUTES = 10;

export async function stuckRemittances(): Promise<ActionResult<StuckRemittance[]>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();
  const { data, error } = await ctx.supabase
    .from("remittances")
    .select("id, reference, party, status, net_amount, transfer_code, gateway_message, created_at")
    .in("status", ["sending", "unknown"])
    .is("ledger_entry_id", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true });

  if (error) return failFromDb(error, "list remittances needing attention");
  return ok((data ?? []) as StuckRemittance[]);
}

/**
 * Completes the ledger posting for a transfer that already went out.
 *
 * Deliberately does NOT re-instruct the gateway. It calls the same idempotent
 * posting function the webhook does, so if the webhook has since succeeded this
 * returns the existing entry and changes nothing.
 *
 * The operator confirms the transfer really happened — we cannot, or we would
 * have posted it already. That confirmation is the whole point of the human
 * step, so it is recorded on the remittance.
 */
export async function completeRemittancePosting(
  remittanceId: string,
  transferCode: string
): Promise<ActionResult<{ entryId: string }>> {
  const { ctx, denied } = await financeContext();
  if (denied) return denied;

  const code = transferCode.trim();
  if (code.length < 3) {
    return fail(
      "Enter the gateway's transfer reference.",
      "Find it in the Paystack dashboard against this remittance. Recording it is what ties our ledger to their record."
    );
  }

  const { data: remittance } = await ctx.supabase
    .from("remittances")
    .select("id, org_id, status, ledger_entry_id, reference")
    .eq("id", remittanceId)
    .maybeSingle();

  if (!remittance) return fail("That remittance could not be found.");
  if (remittance.ledger_entry_id) {
    return fail(
      "This one has already been posted.",
      "The webhook confirmed it while you were looking. Nothing more to do."
    );
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data: entryId, error } = await supabaseAdmin.rpc("record_remittance_sent", {
    p_id: remittanceId,
    p_transfer_code: code,
  });

  if (error) {
    // Still stuck, and now we know why — which is more than the log gave anyone.
    await supabaseAdmin
      .from("remittances")
      .update({ gateway_message: `posting refused: ${error.message}` })
      .eq("id", remittanceId);
    return fail(
      `The ledger refused the posting: ${error.message}`,
      "Do NOT re-send the transfer. This usually means the chart of accounts is incomplete, or the obligation was never recognised."
    );
  }

  revalidatePath("/dashboard/ledger");
  return ok({ entryId: String(entryId) });
}
