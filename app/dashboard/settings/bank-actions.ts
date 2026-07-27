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
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return fail("Only an administrator or finance approver can record an opening balance.");
  }

  const { data: bank } = await supabase
    .from("bank_accounts")
    .select("id, label, ledger_account_id, opening_entry_id")
    .eq("id", bankAccountId)
    .single();
  if (!bank) return fail("That bank account could not be found.");
  if (bank.opening_entry_id) {
    return fail(
      "An opening balance has already been recorded for this account.",
      "Post an adjusting entry instead — the ledger is append-only, so an opening balance is never rewritten."
    );
  }
  if (!bank.ledger_account_id) {
    return fail(
      "This bank account isn't linked to a ledger account yet.",
      "Set up the chart of accounts first, on this same page."
    );
  }

  const lines = allocations.filter((a) => a.accountId && Number(a.amount) > 0);
  const total = lines.reduce((s, a) => s + Number(a.amount), 0);

  if (total <= 0) {
    return fail(
      "Enter what the account held, and whose money it is.",
      "If the account is new and empty, there is nothing to record."
    );
  }

  const { data: entry, error: entryErr } = await supabase
    .from("ledger_entries")
    .insert({
      org_id: me.org_id,
      entry_date: asOfDate,
      description: `Opening balance — ${bank.label}`,
      source: "opening_balance",
      entity_type: "bank_account",
      entity_id: bank.id,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (entryErr) return failFromDb(entryErr, "record the opening balance");

  // Debit the bank for the total; credit each liability for its share. The
  // balancing trigger rejects the whole transaction if these disagree.
  const postings = [
    { org_id: me.org_id, entry_id: entry.id, account_id: bank.ledger_account_id, amount: total,
      memo: "Funds held at go-live" },
    ...lines.map((a) => ({
      org_id: me.org_id,
      entry_id: entry.id,
      account_id: a.accountId,
      amount: -Number(a.amount),
      memo: "Opening allocation",
    })),
  ];

  const { error: postErr } = await supabase.from("ledger_postings").insert(postings);
  if (postErr) return failFromDb(postErr, "post the opening balance");

  await supabase
    .from("bank_accounts")
    .update({ opening_balance: total, opening_date: asOfDate, opening_entry_id: entry.id })
    .eq("id", bank.id);

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
  return ok({ total, entryId: entry.id as string });
}
