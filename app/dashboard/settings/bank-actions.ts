"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
export async function ensureChartOfAccounts() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id").eq("id", user.id).single();
  if (!me) throw new Error("Could not resolve your profile.");

  const { error } = await supabase.rpc("ensure_default_ledger_accounts", {
    p_org_id: me.org_id,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
}

export async function saveBankAccount(input: BankAccountInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    throw new Error("Only an administrator can configure bank accounts.");
  }

  const label = input.label.trim();
  if (label.length < 2) throw new Error("Give the account a label.");

  const last4 = input.accountNumberLast4.trim();
  if (last4 && !/^\d{4}$/.test(last4)) {
    // Catches the common mistake of pasting the whole number.
    throw new Error(
      "Enter the LAST FOUR digits only — we deliberately don't store full account numbers."
    );
  }

  // Point the account at its ledger counterpart so reconciliation knows what to
  // compare the statement against.
  const { data: ledgerAcct } = await supabase
    .from("ledger_accounts")
    .select("id")
    .eq("org_id", me.org_id)
    .eq("purpose", input.purpose === "client_funds" ? "client_funds" : "suspense")
    .limit(1)
    .maybeSingle();

  const row = {
    org_id: me.org_id,
    label,
    purpose: input.purpose,
    bank_name: input.bankName.trim() || null,
    account_name: input.accountName.trim() || null,
    account_number_last4: last4 || null,
    ledger_account_id: ledgerAcct?.id ?? null,
    created_by: user.id,
  };

  const { error } = input.id
    ? await supabase.from("bank_accounts").update(row).eq("id", input.id)
    : await supabase.from("bank_accounts").insert(row);

  if (error) {
    if (error.message.includes("one_client_funds")) {
      throw new Error(
        "This organisation already has an active client-funds account. Edit that one instead — two would make the segregated balance ambiguous."
      );
    }
    throw new Error(error.message);
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
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
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    throw new Error("Only an administrator or finance approver can record an opening balance.");
  }

  const { data: bank } = await supabase
    .from("bank_accounts")
    .select("id, label, ledger_account_id, opening_entry_id")
    .eq("id", bankAccountId)
    .single();
  if (!bank) throw new Error("Bank account not found.");
  if (bank.opening_entry_id) {
    throw new Error(
      "An opening balance has already been recorded for this account. Post an adjusting entry instead — the ledger is append-only."
    );
  }
  if (!bank.ledger_account_id) {
    throw new Error(
      "This bank account isn't linked to a ledger account yet. Set up the chart of accounts first."
    );
  }

  const lines = allocations.filter((a) => a.accountId && Number(a.amount) > 0);
  const total = lines.reduce((s, a) => s + Number(a.amount), 0);

  if (total <= 0) {
    throw new Error(
      "Enter what the account held and who it belongs to. If the account is new and empty, there's nothing to record."
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
  if (entryErr) throw new Error(entryErr.message);

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
  if (postErr) throw new Error(postErr.message);

  await supabase
    .from("bank_accounts")
    .update({ opening_balance: total, opening_date: asOfDate, opening_entry_id: entry.id })
    .eq("id", bank.id);

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/ledger");
  return { total, entryId: entry.id as string };
}
