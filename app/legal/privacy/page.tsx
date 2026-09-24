import type { Metadata } from "next";
import Link from "next/link";
import { legalOrgForHost } from "../legal-org";

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "What personal data this platform holds, why, how long, and your rights over it.",
};

const UPDATED = "24 September 2026";

// The Data Protection Officer designated by the board on 19 August 2026.
const DPO_NAME = "Ebube Ikechwu";

/**
 * Where a data-subject request goes.
 *
 * ⚠️ Never renders blank and never renders a placeholder. The draft this page
 * was built from carried "[email/phone — to be added before publishing]" in
 * four places, and a privacy notice that tells somebody to contact a bracket is
 * worse than no notice: the NDPA requires a route to exercise a right, and an
 * unfilled one is a right you cannot exercise.
 *
 * `DPO_CONTACT_EMAIL` is a single deployment value. Without it the request goes
 * to the organisation's own support desk marked for the DPO — which is a real,
 * monitored route (B1: an org's own address, never the other brand's), not a
 * fiction.
 */
function dpoRoute(orgName: string, support: string | null) {
  const dpo = process.env.DPO_CONTACT_EMAIL?.trim() || null;
  if (dpo) return { address: dpo, viaSupport: false as const };
  if (support) return { address: support, viaSupport: true as const };
  return { address: null, viaSupport: false as const, orgName };
}

function Contact({ orgName, support }: { orgName: string; support: string | null }) {
  const r = dpoRoute(orgName, support);
  if (!r.address) {
    return <>through the Portal, addressed to the Data Protection Officer</>;
  }
  return (
    <>
      at <a href={`mailto:${r.address}`}>{r.address}</a>
      {r.viaSupport ? <> — {orgName}&rsquo;s support address; mark your message for the Data Protection Officer</> : null}
    </>
  );
}

export default async function PrivacyNoticePage() {
  const org = await legalOrgForHost();
  const support = org.supportEmail;

  return (
    <>
      <h1>Privacy Notice</h1>
      <p className="text-muted-foreground">Last updated: {UPDATED}</p>

      <h2>1. Who we are</h2>
      <p>
        This notice covers the integrated facilities and property management platform operated by
        OE Group through its two brands: <strong>TFML — Total Facilities Management Limited</strong>,
        a facilities management company, and <strong>OEA — Ora Egbunike &amp; Associates</strong>, a
        chartered property management and valuation firm. You are reading it on {org.name}&rsquo;s
        portal.
      </p>
      <p>
        Each brand&rsquo;s clients, tenants, vendors and staff use the same underlying platform,
        kept fully separated by organisation. Using this platform — as a tenant, applicant, vendor,
        landlord or staff member — means your personal data is processed as described below.
      </p>
      <p>
        <strong>Data controller:</strong> OE Group. Each client organisation&rsquo;s data is
        controlled by OE Group under its management agreement with that client.
      </p>
      <p>
        <strong>Data Protection Officer:</strong> {DPO_NAME}. Contact{" "}
        <Contact orgName={org.name} support={support} />.
      </p>

      <h2>2. What we collect, and why</h2>
      <ul>
        <li><strong>Identity and contact</strong> — name, email, phone number, Telegram ID. To create your account, reach you, and attribute actions to the right person.</li>
        <li><strong>Tenancy application details</strong> — employment, address, next of kin, income. To assess a tenancy application, with your consent.</li>
        <li><strong>Special-category information</strong>, only where a tenancy application asks for it — religion, marital status. Only with your explicit, separate consent; see section 4.</li>
        <li><strong>Identity documents</strong> — uploaded ID, proof of address, employment letters. To verify who you are and support a tenancy or vendor application.</li>
        <li><strong>Property photographs and video</strong> — maintenance job evidence, inspection photos. To document work carried out, including inside occupied properties.</li>
        <li><strong>Financial records</strong> — payments, rent charges, service charges, payout details. To bill correctly, collect and remit money, and keep an accurate account.</li>
        <li><strong>Communications</strong> — messages sent through WhatsApp, Telegram or the web portal, and your request history. To respond to what you have asked, and keep a record of what was said.</li>
      </ul>
      <p>
        We do not collect more than the above for these purposes, and we do not sell personal data
        to anyone.
      </p>

      <h2>3. The legal basis for processing your data</h2>
      <ul>
        <li><strong>Reviewing a tenancy application</strong> — your consent, and steps taken before entering a contract.</li>
        <li><strong>Running your lease, rent and service charges</strong> — performance of a contract with you.</li>
        <li><strong>Managing a vendor relationship and paying vendors</strong> — performance of a contract.</li>
        <li><strong>Handling maintenance requests and work orders</strong> — our legitimate interest in operating the property properly.</li>
        <li><strong>Keeping an audit trail of who did what</strong> — a legal obligation, and our legitimate interest in an accountable system.</li>
        <li><strong>Religion and marital status</strong>, where collected — your explicit, separate consent only. Never assumed, and never required to proceed.</li>
      </ul>

      <h2>4. Automated checks on your documents — what they do, and do not, decide</h2>
      <p>
        When you submit a tenancy application, some of the initial checks on your documents may be
        assisted by an automated system. Exactly what that means:
      </p>
      <ul>
        <li>The system may check that your documents are complete, legible, internally consistent and not duplicated. It records what it <strong>found</strong> — never a conclusion about you.</li>
        <li><strong>No automated system decides, scores, ranks or recommends an outcome on your application.</strong> A member of staff always reviews your application and documents personally, and a second, independent member of staff makes the final decision. Neither may be the same person.</li>
        <li>Whatever a human reviewer decides, they must record their own stated reason. The automated findings inform that reason; they never replace it.</li>
        <li>If you believe an automated finding about your documents is wrong, you can ask the reviewing team to look again. This is built to be contestable, not final.</li>
        <li>Religion and marital status, where asked, are <strong>never</strong> sent to any automated system. They are seen only by the human reviewers, and only with your explicit consent.</li>
      </ul>
      <p>
        <strong>Consent statement.</strong> By continuing with an application you will be shown a
        specific consent statement covering this. The exact wording you agreed to is kept on your
        application record, so a later change to this notice never silently changes what you
        consented to.
      </p>

      <h2>5. How long we keep your data</h2>
      <ul>
        <li><strong>A tenancy application that is rejected or withdrawn</strong> — 90 days, then your personal details are permanently removed. A record that a decision was made is kept, without your personal details, so the process remains auditable.</li>
        <li><strong>An approved tenancy application</strong> — for the length of the tenancy, plus 6 years after it ends.</li>
        <li><strong>Financial records</strong> (payments, rent, remittances) — retained as a permanent financial record. This cannot be deleted on request, for the same reason a bank statement cannot be un-issued, but you can always ask what is held.</li>
        <li><strong>The audit trail of actions taken on your account</strong> — retained permanently, and cannot be altered by anyone, including OE Group staff.</li>
      </ul>

      <h2>6. Your rights</h2>
      <p>You can ask us to:</p>
      <ul>
        <li><strong>Show you what we hold about you.</strong> Much of it is already visible to you directly — your requests, rent history, statements, payment history, or your own application while it is in progress.</li>
        <li><strong>Correct</strong> inaccurate information. Some of this you can fix yourself in your profile; for the rest, ask your administrator or the Data Protection Officer.</li>
        <li><strong>Delete</strong> your data. This is automatic for a rejected or withdrawn application after 90 days (section 5). For anything else, contact the Data Protection Officer; where a legal reason such as a financial record means we cannot fully delete something, we will explain that clearly rather than simply refusing.</li>
        <li><strong>Withdraw consent</strong> you previously gave.</li>
      </ul>
      <p>
        We aim to respond within <strong>30 days</strong>, as required by the Nigeria Data
        Protection Act 2023. To exercise any of these rights, contact {DPO_NAME}{" "}
        <Contact orgName={org.name} support={support} />.
      </p>

      <h2>7. Who else sees your data</h2>
      <p>
        We use service providers to run this platform — for hosting, messaging, payments and error
        monitoring. They process your data only to provide that service to us, under contract, and
        never for their own purposes. They include our hosting and database provider, our email and
        messaging providers, our payment processors, and our error-monitoring provider.
      </p>
      <p>
        Some are based outside Nigeria. Our production systems are hosted in Ireland, and transfers
        outside Nigeria are made under contractual clauses with each provider, as section 41 of the
        Nigeria Data Protection Act 2023 permits. You can ask us{" "}
        <Contact orgName={org.name} support={support} /> for the current list of providers and the
        safeguards that apply to each.
      </p>

      <h2>8. How we keep your data secure</h2>
      <ul>
        <li>All data is encrypted in transit and at rest.</li>
        <li>Access is restricted by role — a member of staff can only see what their role and assignment require, and this is enforced by the system itself, not only by policy.</li>
        <li>Every action taken on your data is recorded in a permanent, tamper-evident audit trail.</li>
        <li>Identity documents and property photographs and video are stored privately, and are not publicly accessible by URL.</li>
      </ul>

      <h2>9. If something goes wrong</h2>
      <p>
        We keep a written procedure for handling a personal data breach, and it runs to fixed
        deadlines:
      </p>
      <ul>
        <li>Our Data Protection Officer is told <strong>immediately</strong>, without waiting for certainty about what happened.</li>
        <li>Where a breach is likely to result in a risk to your rights and freedoms, we notify the Nigeria Data Protection Commission <strong>within 72 hours</strong> of becoming aware of it.</li>
        <li>Where a breach is likely to result in a <strong>high</strong> risk to you, we tell you as well, immediately and in parallel — not after the Commission has responded.</li>
      </ul>
      <p>
        We will tell you what happened, what data was involved, what we are doing about it, and what
        you can do to protect yourself.
      </p>

      <h2>10. Changes to this notice</h2>
      <p>
        We will update this notice as needed and change the date at the top. Where a change is
        significant, we will take reasonable steps to let you know before it takes effect.
      </p>

      <h2>11. Contact</h2>
      <p>
        Data Protection Officer: {DPO_NAME} — contact{" "}
        <Contact orgName={org.name} support={support} />.
      </p>
      <p>
        For anything else, contact {org.name}
        {support ? <> at <a href={`mailto:${support}`}>{support}</a></> : " through the Portal"}. Our{" "}
        <Link href="/legal/terms">Terms of Service</Link> and{" "}
        <Link href="/legal/refunds">Refund Policy</Link> sit alongside this notice.
      </p>
    </>
  );
}
