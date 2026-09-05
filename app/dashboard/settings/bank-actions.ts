"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";

// Bank-account configuration. Admin-only at the RLS layer; these actions add
// validation and keep the ledger consistent with what is configured.

export type BankAccountInput = {
  id?: string;
  label: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
  purpose: "client_funds" | "operating";
  /** ISO 4217. Defaults NGN — every account before Flutterwave/FX was this. */
  currency?: string;
};

/** Creates the standard (Naira) chart of accounts if the org has none yet. */
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

/**
 * Provisions the client_funds + suspense pair for a FOREIGN currency (0103).
 *
 * Deliberately a separate, narrower call from `ensureChartOfAccounts()` — a
 * new currency needs only what an FX collection can ever touch (Flutterwave is
 * collections-only, B3), not the landlord/vendor/deposit accounts a domestic
 * Naira obligation needs. Calling this for 'NGN' is a harmless no-op; the
 * standard chart already carries it.
 */
export async function ensureCurrencyLedgerAccounts(currency: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  if (me?.role !== "admin") {
    return fail("Only an administrator can enable a currency.");
  }

  const { error } = await supabase.rpc("ensure_currency_ledger_accounts", {
    p_org_id: me.org_id,
    p_currency: currency.toUpperCase(),
  });
  if (error) return failFromDb(error, `enable ${currency.toUpperCase()} collections`);
  revalidatePath("/dashboard/settings/banking");
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

  const currency = (input.currency || "NGN").toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    return fail(
      `${currency} is not a supported currency.`,
      `Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.`
    );
  }

  // Currency is fixed at creation, like an account's identity — changing it on
  // an existing row would re-point ledger_account_id at a DIFFERENT currency's
  // ledger account while every historical posting stays tied to the old one,
  // silently orphaning them from the account that is now "the" client-funds
  // account for that currency.
  if (input.id) {
    const { data: existing } = await supabase
      .from("bank_accounts").select("currency").eq("id", input.id).maybeSingle();
    if (existing && existing.currency !== currency) {
      return fail(
        `This account is denominated in ${existing.currency} and cannot be changed to ${currency}.`,
        "Add a separate account for the other currency instead."
      );
    }
  }

  // A foreign currency's accounts must exist before a bank account can point at
  // one — `canonical_ledger_account` below would otherwise resolve to nothing
  // and this would silently save a bank account with no ledger counterpart.
  // Idempotent, so calling it on every save (including edits to an existing
  // NGN account) costs nothing.
  if (currency !== "NGN") {
    const { error: enableErr } = await supabase.rpc("ensure_currency_ledger_accounts", {
      p_org_id: me.org_id, p_currency: currency,
    });
    if (enableErr) return failFromDb(enableErr, `enable ${currency} collections`);
  }

  // Point the account at its ledger counterpart, IN THIS CURRENCY, so
  // reconciliation knows what to compare the statement against — and so the
  // opening balance posts to the right place.
  //
  // Resolved by canonical_ledger_account rather than picking a row here: this
  // used to be `.limit(1)` with no ordering, and it linked a real client-funds
  // account to a leftover test account. Whichever row the planner returns is
  // not an acceptable answer to "which account holds the client's money" — and
  // now that an org can hold the SAME purpose in several currencies (0103),
  // "whichever" would be actively wrong, not just unlucky.
  const { data: ledgerAccountId } = await supabase.rpc("canonical_ledger_account", {
    p_org_id: me.org_id,
    p_purpose: input.purpose === "client_funds" ? "client_funds" : "suspense",
    p_currency: currency,
  });

  const row = {
    org_id: me.org_id,
    label,
    purpose: input.purpose,
    bank_name: input.bankName.trim() || null,
    account_name: input.accountName.trim() || null,
    account_number_last4: last4 || null,
    currency,
    ledger_account_id: (ledgerAccountId as string | null) ?? null,
    created_by: user.id,
  };

  const { error } = input.id
    ? await supabase.from("bank_accounts").update(row).eq("id", input.id)
    : await supabase.from("bank_accounts").insert(row);

  if (error) {
    if (error.message.includes("one_client_funds")) {
      return fail(
        `This organisation already has an active ${currency} client-funds account.`,
        "Edit that one instead — two would make its segregated balance ambiguous."
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
