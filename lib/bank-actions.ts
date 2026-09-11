"use server";

import { ok, fail, type ActionResult } from "./action-result";
import { createClient } from "./supabase/server";

// Nigerian bank lookups, shared by every screen that asks somebody for a bank
// account.
//
// ⚠️ Lifted out of `app/dashboard/vendors/[id]/payout-actions.ts` so there is
// ONE bank list. Two hand-maintained lists of Nigerian banks is how "GTB",
// "GTBank" and "Guaranty Trust" become three different strings — the exact
// failure decision 20 recorded for locations, where three spellings of Port
// Harcourt defeated a sibling-name constraint because they are genuinely
// different strings. A closed list offered as a dropdown is what stops it, and
// there must be exactly one of them.

const FALLBACK_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "030", name: "Heritage Bank" },
  { code: "301", name: "Jaiz Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "50211", name: "Kuda Bank" },
  { code: "526", name: "Parallex Bank" },
  { code: "999991", name: "PalmPay" },
  { code: "999992", name: "OPay" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "100", name: "Suntrust Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "033", name: "United Bank for Africa" },
  { code: "215", name: "Unity Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
] as const;

/**
 * Every bank a Nigerian account can be held at.
 *
 * Falls back to a hardcoded list when no Paystack key is configured, so the
 * picker still works in a demo or a local build — a dropdown that is empty
 * because a key is missing is a form nobody can complete, and the reason would
 * not be visible on screen.
 */
export async function listBanks(): Promise<ActionResult<{ code: string; name: string }[]>> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return ok([...FALLBACK_BANKS]);

  try {
    const res = await fetch("https://api.paystack.co/bank?currency=NGN&perPage=100", {
      headers: { Authorization: `Bearer ${key}` },
      // Bank lists change rarely; re-fetching per page load is waste.
      next: { revalidate: 86_400 },
    });
    const json = (await res.json()) as {
      status?: boolean;
      data?: { code: string; name: string }[];
    };
    if (!res.ok || !json.status || !json.data) {
      // The live list failed, but the form still has to be completable.
      return ok([...FALLBACK_BANKS]);
    }
    return ok(
      json.data
        .map((b) => ({ code: b.code, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch {
    return ok([...FALLBACK_BANKS]);
  }
}

/**
 * Asks the bank who holds an account, and returns only the name.
 *
 * ⚠️ THIS IS NOT `createTransferRecipient`, and the difference is the whole
 * point. That call also resolves a name — as a side effect of creating a PAYOUT
 * TARGET at the gateway. Using it here would turn every tenant's personal
 * account into somewhere this organisation can send money, which is the precise
 * inversion of the control decision 17 exists to keep ("bank details are stated
 * and evidenced, never actionable"). `GET /bank/resolve` reads; it creates
 * nothing.
 *
 * ⚠️ The account number is passed through and NEVER returned or stored. The
 * caller keeps the last four and the resolved name — the same shape
 * `payout_recipients` has held since 0040b.
 */
export async function resolveBankAccount(input: {
  accountNumber: string;
  bankCode: string;
}): Promise<ActionResult<{ accountName: string; last4: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // Signed-in only. Account-name resolution is a paid third-party call and a
  // mild enumeration primitive; it is not something to leave open.
  if (!user) return fail("Your session expired. Please sign in again.");

  const number = (input.accountNumber ?? "").replace(/\D/g, "");
  if (number.length < 6) {
    return fail("That account number looks too short.");
  }
  if (!input.bankCode) {
    return fail("Choose the bank the account is held at first.");
  }
  const last4 = number.slice(-4);

  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    // No gateway configured (demo, local). The name cannot be proved, so it is
    // not asserted — the caller falls back to letting the person type it, and
    // the audit desk still has the receipt.
    return fail(
      "We cannot check that account automatically here.",
      "Type the account name as it appears on your bank app instead."
    );
  }

  try {
    const res = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(number)}&bank_code=${encodeURIComponent(input.bankCode)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const json = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: { account_name?: string };
    };
    if (!res.ok || !json.status || !json.data?.account_name) {
      return fail(
        json.message?.replace(/\.$/, "") ??
          "That account could not be found at the bank you chose.",
        "Check the number and the bank, or type the account name yourself."
      );
    }
    return ok({ accountName: json.data.account_name, last4 });
  } catch {
    return fail(
      "We could not reach the bank to check that account.",
      "Type the account name yourself and carry on — it does not stop you."
    );
  }
}
