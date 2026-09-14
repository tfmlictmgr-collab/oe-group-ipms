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
      // 📌 Refreshed on its own every six hours (board, 12 Sept 2026: "the
      // list should automatically update when there are new banks"). A newly
      // licensed bank or a renamed one appears within the day with no change
      // to this code; re-fetching on every page load would be waste, and the
      // list is the same for every organisation — it names banks, not anybody's
      // customers — so one key serving it leaks nothing.
      next: { revalidate: 21_600 },
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

  // ⚠️ On the CALLER'S organisation's own key (0289). This used the platform
  // key for everybody, so an OEA tenant's account number was sent to Paystack
  // under TFML's merchant account — decision 47's rule broken on a read. The
  // shared helper asks on the organisation's own key, or the platform key only
  // for the one organisation that owns it, or not at all.
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).maybeSingle();
  if (!me?.org_id) return fail("Your session expired. Please sign in again.");

  const { lookUpAccountName } = await import("./bank-resolve");
  const found = await lookUpAccountName(me.org_id, number, input.bankCode);
  if (!found.ok) {
    return fail(
      found.reason,
      found.unavailable
        ? "Type the account name yourself and carry on — it does not stop you."
        : "Check the number and the bank, or type the account name yourself."
    );
  }
  return ok({ accountName: found.accountName, last4: found.last4 });
}
