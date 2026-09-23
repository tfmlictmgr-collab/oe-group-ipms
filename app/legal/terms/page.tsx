import type { Metadata } from "next";
import Link from "next/link";
import { legalOrgForHost } from "../legal-org";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of this portal and payments made through it.",
};

const UPDATED = "22 September 2026";

export default async function TermsPage() {
  const org = await legalOrgForHost();
  const contact = org.supportEmail;

  return (
    <>
      <h1>Terms of Service</h1>
      <p className="text-muted-foreground">Last updated: {UPDATED}</p>

      <p>
        These terms govern your use of the {org.name} portal (the &ldquo;Portal&rdquo;) and any
        payment you make through it. In these terms, &ldquo;we&rdquo;, &ldquo;us&rdquo; and
        &ldquo;our&rdquo; mean {org.name}; &ldquo;you&rdquo; means the person or organisation using
        the Portal. By signing in, submitting an application or making a payment, you accept these
        terms.
      </p>

      <h2>1. What the Portal does</h2>
      <p>
        {org.name} provides facilities management and property management services. The Portal lets
        tenants, occupants, property owners, vendors and our staff raise and track service requests,
        view statements, apply for tenancies, and pay rent, service charges, deposits and other
        amounts due under an agreement with us or with a property owner we act for.
      </p>

      <h2>2. Accounts and access</h2>
      <ul>
        <li>Accounts are issued by invitation. You must give accurate information and keep it up to date.</li>
        <li>
          You are responsible for keeping your password and any second-factor codes confidential, and
          for activity under your account. Tell us promptly if you suspect unauthorised use.
        </li>
        <li>
          You may only access information you are entitled to see. Attempting to reach another
          person&rsquo;s or organisation&rsquo;s data, or to interfere with the Portal&rsquo;s
          security, is prohibited.
        </li>
        <li>We may suspend or withdraw access where these terms are breached or the underlying agreement ends.</li>
      </ul>

      <h2>3. Payments</h2>
      <ul>
        <li>
          The amount of any rent, service charge, deposit or fee is set by your tenancy, lease,
          service-charge budget or other agreement — not by these terms. The Portal shows what is
          due and records what is paid.
        </li>
        <li>
          Card and online payments are processed by licensed third-party payment processors
          (Paystack and Flutterwave). We do not receive or store your full card details. The
          processor&rsquo;s own terms also apply to the transaction.
        </li>
        <li>
          Where a processing fee is passed to you, it is shown before you pay and is retained by the
          processor.
        </li>
        <li>
          Where we collect money on behalf of a property owner or client, it is held in our
          designated client-funds bank account, recorded in a segregated ledger, and disbursed only
          through our approval process.
        </li>
        <li>
          If you pay by direct bank transfer or bank deposit, the payment is credited to your account
          once it has been confirmed against our bank records. A payment recorded in the Portal but
          not yet confirmed is not a receipt.
        </li>
        <li>
          Only pay into an account held in the name {org.name}. We will never ask you by phone or
          message to pay into a personal account. If in doubt, contact us before paying.
        </li>
        <li>Refunds are handled under our <Link href="/legal/refunds">Refund Policy</Link>.</li>
      </ul>

      <h2>4. Tenancy applications</h2>
      <p>
        Applications are reviewed by people, not decided by an automated system. Automated checks
        may help verify documents you upload, but a member of staff makes and records every
        decision. Submitting an application does not guarantee a tenancy; a tenancy exists only when
        an offer has been issued and accepted and the tenancy is recorded.
      </p>

      <h2>5. Your data</h2>
      <p>
        We process personal data in accordance with the Nigeria Data Protection Act 2023 and, where
        it applies, the GDPR. We use your data to provide the services, meet our legal and
        accounting obligations, and keep the Portal secure. We share it only with processors who
        help us deliver the service (for example payment processors and messaging providers) under
        written agreements. You may ask to access, correct or delete your data, subject to our legal
        retention obligations, by contacting our Data Protection Officer
        {contact ? <> at <a href={`mailto:${contact}`}>{contact}</a></> : null}.
      </p>

      <h2>6. Acceptable use</h2>
      <p>
        You must not use the Portal to upload unlawful, false or misleading material, to submit
        forged documents or proofs of payment, to harass any person, or to introduce malicious code.
        Records of payments and approvals are kept in an audit trail that cannot be edited.
      </p>

      <h2>7. Availability</h2>
      <p>
        We aim to keep the Portal available at all times but cannot guarantee uninterrupted
        service. Maintenance, network or third-party outages may occasionally affect access. If you
        cannot pay through the Portal, contact us for another way to pay.
      </p>

      <h2>8. Intellectual property</h2>
      <p>
        The Portal, its software and content belong to us or our licensors. You may use them only
        to access the services described here. Documents you upload remain yours; you give us the
        right to use them for the purpose you provided them.
      </p>

      <h2>9. Liability</h2>
      <p>
        Nothing in these terms limits liability that cannot be limited by law. Otherwise, we are not
        liable for indirect or consequential loss, or for loss caused by events outside our
        reasonable control, including failures of banks, payment processors or telecommunications
        networks. Our obligations to you in respect of a property are those set out in the
        relevant tenancy, lease or service agreement.
      </p>

      <h2>10. Changes to these terms</h2>
      <p>
        We may update these terms from time to time. The date at the top shows when they last
        changed. Material changes will be notified through the Portal or by email.
      </p>

      <h2>11. Governing law</h2>
      <p>
        These terms are governed by the laws of the Federal Republic of Nigeria, and disputes are
        subject to the jurisdiction of the Nigerian courts.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about these terms can be sent to {org.name}
        {contact ? <> at <a href={`mailto:${contact}`}>{contact}</a></> : " through the Portal"}.
      </p>
    </>
  );
}
