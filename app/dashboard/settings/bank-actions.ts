"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Bank-account configuration. Admin-only at the RLS layer; these actions add
// validation and keep the ledger consistent with what is configured.

export type BankAccountInput = {
  id?: string;
  label: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
  purpose: "client_funds" | "operating";
};

/** Creates the standard chart of accounts if the org has none yet. */
export async function ensureChartOfAccounts(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const { error } = await supabase.rpc("ensure_default_ledger_accounts", {
    p_org_id: me.org_id,
  });
  if (error) return failFromDb(error, "set up the chart of accounts");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
  return ok();
}

export async function saveBankAccount(input: BankAccountInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    return fail("Only an administrator can configure bank accounts.");
  }

  const label = input.label.trim();
  if (label.length < 2) return fail("Give the account a label.");

  const last4 = input.accountNumberLast4.trim();
  if (last4 && !/^\d{4}$/.test(last4)) {
    // Catches the common mistake of pasting the whole number.
    return fail(
      "Enter the LAST FOUR digits only.",
      "Full account numbers are deliberately never stored — the last four are all reconciliation needs."
    );
  }

  // Point the account at its ledger counterpart so reconciliation knows what to
  // compare the statement against — and so the opening balance posts to the
  // right place.
  //
  // Resolved by canonical_ledger_account rather than picking a row here: this
  // used to be `.limit(1)` with no ordering, and it linked a real client-funds
  // account to a leftover test account. Whichever row the planner returns is
  // not an acceptable answer to "which account holds the client's money".
  const { data: ledgerAccountId } = await supabase.rpc("canonical_ledger_account", {
    p_org_id: me.org_id,
    p_purpose: input.purpose === "client_funds" ? "client_funds" : "suspense",
  });

  const row = {
    org_id: me.org_id,
    label,
    purpose: input.purpose,
    bank_name: input.bankName.trim() || null,
    account_name: input.accountName.trim() || null,
    account_number_last4: last4 || null,
    ledger_account_id: (ledgerAccountId as string | null) ?? null,
    created_by: user.id,
  };

  const { error } = input.id
    ? await supabase.from("bank_accounts").update(row).eq("id", input.id)
    : await supabase.from("bank_accounts").insert(row);

  if (error) {
    if (error.message.includes("one_client_funds")) {
      return fail(
        "This organisation already has an active client-funds account.",
        "Edit that one instead — two would make the segregated balance ambiguous."
      );
    }
    return failFromDb(error, "save this bank account");
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
  return ok();
}

export type OpeningAllocation = { accountId: string; amount: number };

/**
 * Records the opening balance as a real, balanced ledger entry.
 *
 * Storing a number on the bank row would be cosmetic — the ledger would still
 * start at zero and every reconciliation would show a permanent variance. So
 * this posts: debit client funds for the total, credit each liability for whose
 * money it is. The allocation is required rather than optional, because "held"
 * with no matching "owed" is exactly the state the segregation check exists to
 * detect.
 */
export async function recordOpeningBalance(
  bankAccountId: string,
  asOfDate: string,
  allocations: OpeningAllocation[]
): Promise<ActionResult<{ total: number; entryId: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const lines = allocations.filter((a) => a.accountId && Number(a.amount) > 0);
  if (lines.length === 0) {
    return fail(
      "Enter what the account held, and whose money it is.",
      "If the account is new and empty, there is nothing to record."
    );
  }

  // One call, one transaction. This used to insert the entry and then the
  // postings separately, so a failure between them left an entry with no
  // postings — invisible to the balancing trigger, which fires on postings.
  // The function re-checks the caller's role and org itself, since it runs
  // SECURITY DEFINER.
  const { data, error } = await supabase.rpc("record_opening_balance", {
    p_bank_account_id: bankAccountId,
    p_as_of: asOfDate,
    p_allocations: lines.map((a) => ({ accountId: a.accountId, amount: Number(a.amount) })),
  });

  if (error) {
    // The function's own refusals are written for a person to read.
    return fail(error.message.replace(/^.*?:\s*/, ""));
  }

  const result = data as { total: number; entryId: string };
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
  return ok({ total: Number(result.total), entryId: String(result.entryId) });
}
