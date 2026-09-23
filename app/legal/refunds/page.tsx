import type { Metadata } from "next";
import Link from "next/link";
import { legalOrgForHost } from "../legal-org";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "When and how payments made through this portal are refunded.",
};

const UPDATED = "22 September 2026";

export default async function RefundPolicyPage() {
  const org = await legalOrgForHost();
  const contact = org.financeEmail;

  return (
    <>
      <h1>Refund Policy</h1>
      <p className="text-muted-foreground">Last updated: {UPDATED}</p>

      <p>
        This policy explains when {org.name} refunds a payment made through its portal, by card,
        online transfer, direct bank transfer or bank deposit. It forms part of our{" "}
        <Link href="/legal/terms">Terms of Service</Link>.
      </p>

      <h2>1. What we pay for you, and why refunds are limited</h2>
      <p>
        Payments through the Portal are for rent, service charges, deposits and other amounts set by
        a tenancy, lease or service agreement. Much of this money is collected on behalf of property
        owners and held in a designated client-funds account. Because these payments settle an
        amount you owe, they are not refundable simply because you change your mind. A refund is
        made in the situations below.
      </p>

      <h2>2. When you are entitled to a refund</h2>
      <ul>
        <li><strong>Duplicate payment</strong> — the same charge paid more than once.</li>
        <li><strong>Overpayment</strong> — you paid more than the amount due.</li>
        <li><strong>Payment in error</strong> — a charge that was raised or applied to you by mistake.</li>
        <li>
          <strong>Failed transaction</strong> — your account was debited but the payment did not
          complete. These are usually reversed automatically by your bank or the payment processor
          within 24–72 hours; if not, we will refund once the processor confirms the funds reached us.
        </li>
        <li>
          <strong>Refundable deposit</strong> — returned at the end of a tenancy in line with the
          tenancy agreement, less any deductions it permits (for example unpaid rent or damage
          beyond fair wear and tear), with an itemised statement.
        </li>
        <li>
          <strong>Declined or withdrawn tenancy</strong> — any amount paid towards a tenancy offer
          that is withdrawn by us, or that we decline, is refunded in full.
        </li>
      </ul>
      <p>
        Where the tenancy or service agreement you signed provides different refund terms, those
        terms apply.
      </p>

      <h2>3. How to request a refund</h2>
      <p>
        Contact us{contact ? <> at <a href={`mailto:${contact}`}>{contact}</a></> : " through the Portal"}{" "}
        within 30 days of the payment, giving the payment reference, the amount, the date and the
        reason. For a bank transfer or deposit, include the bank&rsquo;s receipt or teller.
      </p>

      <h2>4. How long it takes</h2>
      <ul>
        <li>We acknowledge a refund request within 2 business days.</li>
        <li>We decide on it within 10 business days and tell you the outcome and reasons in writing.</li>
        <li>
          Approved refunds are initiated within 5 business days of approval. Card refunds can take a
          further 5–10 business days to appear, depending on your bank.
        </li>
      </ul>

      <h2>5. How refunds are paid</h2>
      <ul>
        <li>Card and online payments are refunded to the original payment method where the processor allows.</li>
        <li>
          Bank transfers and deposits are refunded by bank transfer to an account in the name of the
          person who paid. We will ask for evidence of the account before paying.
        </li>
        <li>
          Refunds are made in the currency of the original payment. We do not cover exchange-rate
          differences.
        </li>
        <li>
          Processing fees charged by the payment processor are not refundable, except where the
          refund is due to our error.
        </li>
      </ul>

      <h2>6. Money already paid to a property owner</h2>
      <p>
        Where the payment has already been passed to the property owner, we will recover it from
        the owner&rsquo;s next remittance or by agreement with them before refunding you. We will
        tell you if this affects the timeline.
      </p>

      <h2>7. Chargebacks</h2>
      <p>
        Please contact us before disputing a payment with your bank — most issues are resolved
        faster directly. If a chargeback is raised, we will provide the payment records to the
        processor, and any refund already made will not be paid twice.
      </p>

      <h2>8. Complaints</h2>
      <p>
        If you are unhappy with how a refund request was handled, reply to our decision and it will
        be reviewed by a senior member of staff who was not involved in the original decision.
      </p>
    </>
  );
}
