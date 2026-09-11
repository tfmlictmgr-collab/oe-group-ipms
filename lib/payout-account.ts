import { fail, type ActionResult } from "@/lib/action-result";

/**
 * "no verified bank recipient is on file for this vendor" — said properly.
 *
 * ⚠️ The refusal itself is correct and stays. Decision 17 is explicit that the
 * bank details a vendor states on their own registration are **stated and
 * evidenced, never actionable**: the last four digits plus the bank's own
 * letter, with 0040b's rule unchanged — the full account number goes to the
 * gateway once and is never stored by us. `payout_recipients` holds the
 * gateway's recipient code, and that code is the only thing money can be sent
 * to. There is deliberately **no path** from a registration into that table.
 *
 * So a vendor can complete their pack, attach their bank letter, be approved,
 * and still be unpayable — which is the intended state, and which the product
 * described to the one person who cannot fix it as eleven words of database
 * exception. The payment officer reads "no verified bank recipient is on file
 * for this vendor", looks at the vendor's own screen showing a bank, an account
 * name and four digits, and concludes the system has lost them.
 *
 * `lib/remittance-run.ts` already learned this lesson for the *second* recipient
 * check ("Open Vendors → that contractor → Payout account…"). This is the same
 * sentence for the FIRST one, which fires earlier and had no hint at all.
 */
const NO_RECIPIENT =
  /no verified bank recipient|no verified gateway recipient|has no verified bank recipient/i;

/**
 * Rewrites a payout refusal into something the reader can act on, or returns
 * null when the refusal is about something else entirely and should be shown
 * verbatim — most of what these functions raise is already written for a person
 * and flattening all of it would be worse than the problem being fixed.
 */
export function payoutRefusal(
  rawMessage: string,
  payeeName: string
): ActionResult<never> | null {
  if (!NO_RECIPIENT.test(rawMessage)) return null;

  return fail(
    `${payeeName} has no verified payout account yet, so there is nowhere to send this.`,
    // Names the place AND the person, because the payment officer holds neither
    // half: only an administrator may register a payout account (bank details
    // are configuration, not operations — the same separation as bank_accounts
    // in 0028), and the form is on the contractor's own page, not this one.
    "The bank details on a vendor's registration are evidence of who they are — " +
      "they are not payment instructions, and nothing turns them into one automatically. " +
      "An administrator opens Vendors → this contractor → Payout details, enters the " +
      "account from their bank letter, and the bank confirms the name before it is saved. " +
      "Nothing has been sent."
  );
}

/** What the vendor themselves stated, for the person registering the account. */
export type StatedBankDetails = {
  bankName: string | null;
  accountName: string | null;
  last4: string | null;
  /** Storage path of the bank letter/statement they attached, when there is one. */
  evidencePath: string | null;
  evidenceFileName: string | null;
};

/**
 * ⚠️ An account NAME that is a run of digits is an account NUMBER in the wrong
 * box. Measured on staging: both registrations carrying bank details had the
 * full ten-digit number sitting in `account_name`, with `account_number_last4`
 * correctly derived from it — so the person filling the form read "Account
 * name" as "account", and the product stored precisely the value 0164's own
 * comment says it must never hold. `0262` refuses it going forward; this is the
 * reader's half, so a pack written before that migration is not quietly
 * displayed as though the number belonged there.
 */
export function looksLikeAnAccountNumber(value: string | null): boolean {
  return value != null && /^[\d\s-]{6,}$/.test(value.trim());
}
