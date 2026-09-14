import { formatNaira } from "@/lib/currency";

/**
 * The letter of offer that follows an approved tenancy application (0263).
 *
 * ⚠️ The sequence this exists to fix. Approval used to issue a PORTAL
 * INVITATION and an email reading "your application was approved — set up your
 * account". That is an account, not an offer: it names no rent, no term, no
 * deposit and nothing to accept, because at the moment of approval this schema
 * held none of those figures. Rent first existed when a lease was written,
 * which is *after* the tenant is supposed to have agreed to it.
 *
 * Offer → acceptance → lease. The token here is the applicant's whole
 * authority, exactly as the application resume token is: only its SHA-256 is
 * stored, so a database reader cannot accept somebody's tenancy.
 *
 * ⚠️ Formatting and derivation ONLY — this module is imported by client
 * components, so the token's hashing lives in `lib/tenancy-offer-token.ts`
 * where `node:crypto` never reaches a browser bundle.
 */

/** How long an offer stands, unless the reviewer says otherwise. */
export const OFFER_DAYS = 14;

export type OfferTerms = {
  rentAmount: number;
  serviceChargeAmount: number;
  depositAmount: number;
  otherChargesAmount: number;
  otherChargesLabel: string | null;
  termMonths: number;
  commencesOn: string;
  expiresOn: string;
  conditions: string | null;
};

/**
 * What falls due when the offer is accepted.
 *
 * ⚠️ Rent and service charge are listed SEPARATELY and always will be — they
 * are different money going to different places (decision 25), and this is the
 * one figure that legitimately sums them because it answers a different
 * question: not "what is the rent" but "what does the tenant transfer to take
 * the flat". The deposit is in it because it is payable then; it is refundable
 * and the letter says so.
 */
export function payableOnAcceptance(t: OfferTerms): number {
  return (
    Number(t.rentAmount) +
    Number(t.serviceChargeAmount) +
    Number(t.depositAmount) +
    Number(t.otherChargesAmount)
  );
}

export function termLabel(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return years === 1 ? "12 months" : `${years} years (${months} months)`;
  }
  return `${months} months`;
}

export const offerDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleDateString("en-NG", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

/** The end date implied by the commencement and the term, for the lease form. */
export function endDateFor(commencesOn: string, termMonths: number): string {
  const d = new Date(commencesOn + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + termMonths);
  // A tenancy runs TO the day before the anniversary; `leases_no_overlap`
  // excludes on a daterange, so an end date landing exactly on the next term's
  // start date makes a renewal collide with its own predecessor.
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The money block, shared by the email and the page so they cannot disagree. */
export function termLines(t: OfferTerms): { label: string; value: string }[] {
  const lines = [
    { label: "Rent", value: `${formatNaira(t.rentAmount)} per annum` },
  ];
  if (Number(t.serviceChargeAmount) > 0) {
    lines.push({
      label: "Service charge",
      value: `${formatNaira(t.serviceChargeAmount)} per annum`,
    });
  }
  if (Number(t.otherChargesAmount) > 0) {
    lines.push({
      label: t.otherChargesLabel ?? "Other charges",
      value: formatNaira(t.otherChargesAmount),
    });
  }
  if (Number(t.depositAmount) > 0) {
    lines.push({
      label: "Security deposit",
      value: `${formatNaira(t.depositAmount)}, refundable at the end of the term`,
    });
  }
  return lines;
}
