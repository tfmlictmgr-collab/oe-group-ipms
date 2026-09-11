import { sendEmail, type MailContext } from "@/lib/email";
import { formatNaira } from "@/lib/currency";
import {
  type OfferTerms,
  payableOnAcceptance,
  termLabel,
  offerDate,
  termLines,
} from "@/lib/tenancy-offer";

/**
 * Everything an APPLICANT is sent about their own tenancy application.
 *
 * ⚠️ Three of the four did not exist. Traced end to end (0263):
 *
 *   starting an application  → emailed the resume link          ✅
 *   SUBMITTING it            → nothing at all                   ❌
 *   asked for more           → emailed                          ✅
 *   APPROVED                 → "set up your account"            ⚠️ not an offer
 *   REJECTED                 → nothing at all                   ❌
 *
 * Submission was silent: somebody hands over their ID, their bank statements
 * and their employer's details and receives no acknowledgement, no reference
 * and no statement of what happens next. Their reference appeared once on the
 * screen and nowhere afterwards.
 *
 * Rejection was silent too, which is worse than discourteous — decision 10's
 * entire basis is that the reviewer's recorded reason is CONTESTABLE, and a
 * person cannot contest a decision nobody told them about.
 *
 * All four live here rather than beside the actions that trigger them, because
 * they are one voice speaking to one person across one process, and copy that
 * lives in four files drifts into four voices. Every one takes the brand from
 * `MailContext` — a TFML applicant must never read "OE Group" (B1).
 *
 * Best-effort throughout: a decision is recorded in the database before any of
 * this runs, and a mail provider being down must never roll one back.
 */

export type ApplicantRef = {
  applicationId: string;
  orgId: string;
  email: string;
  name: string;
};

/** 1 — We have it. Sent the moment an application is submitted. */
export async function sendSubmissionAcknowledgement(
  a: ApplicantRef,
  reference: string,
  isResubmission: boolean
): Promise<boolean> {
  const res = await sendEmail({
    to: a.email,
    orgId: a.orgId,
    category: "account",
    entityType: "tenant_application",
    entityId: a.applicationId,
    subject: (ctx: MailContext) =>
      isResubmission
        ? `${ctx.brandName} — we have your updated application (${reference})`
        : `${ctx.brandName} — we have your tenancy application (${reference})`,
    text: (ctx: MailContext) =>
      [
        `Dear ${a.name},`,
        ``,
        isResubmission
          ? `Thank you — your updated application has reached us and is back with the`
          : `Thank you — your tenancy application has reached us and is with the`,
        `team at ${ctx.brandName} for review.`,
        ``,
        `Your reference:  ${reference}`,
        ``,
        `What happens next. A member of the letting team reads your application and`,
        `the documents you attached. Two people are involved in the decision, and`,
        `it is made by people rather than by any automated system. If anything is`,
        `missing or unclear we will email you with a link to add it.`,
        ``,
        `If your application is successful you will receive a written offer setting`,
        `out the unit, the term, the rent, the service charge and the deposit, with`,
        `a date by which to accept. Nothing is due, and nothing should be paid to`,
        `anyone, until you have that offer in writing from us.`,
        ``,
        `You do not need to do anything for now. If you need to reach us about this,`,
        `reply to this email and quote the reference above.`,
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
  });
  return res.sent;
}

/** 2 — The letter of offer. What actually follows a successful application. */
export async function sendOfferLetter(
  a: ApplicantRef,
  terms: OfferTerms,
  where: { propertyName: string | null; propertyAddress: string | null; unitLabel: string | null },
  acceptUrl: string
): Promise<boolean> {
  const place = [where.unitLabel, where.propertyName].filter(Boolean).join(", ");
  const money = termLines(terms);
  const width = Math.max(...money.map((l) => l.label.length), 16);
  const pad = (s: string) => s.padEnd(width, " ");

  const res = await sendEmail({
    to: a.email,
    orgId: a.orgId,
    category: "account",
    entityType: "tenant_application",
    entityId: a.applicationId,
    subject: () => `Offer of tenancy — ${place || "your application"}`,
    text: (ctx: MailContext) =>
      [
        `Dear ${a.name},`,
        ``,
        `Following the review of your application, we are pleased to offer you a`,
        `tenancy of the following, on the terms set out below.`,
        ``,
        `  ${pad("Property")}  ${where.propertyName ?? "—"}`,
        ...(where.propertyAddress ? [`  ${pad("")}  ${where.propertyAddress}`] : []),
        `  ${pad("Unit")}  ${where.unitLabel ?? "—"}`,
        `  ${pad("Term")}  ${termLabel(terms.termMonths)}, commencing ${offerDate(terms.commencesOn)}`,
        ``,
        ...money.map((l) => `  ${pad(l.label)}  ${l.value}`),
        ``,
        `  ${pad("Payable to accept")}  ${formatNaira(payableOnAcceptance(terms))}`,
        ``,
        // Decision 15, said plainly: annually in advance is the norm here, and
        // an offer that leaves it implied is one a tenant cannot plan against.
        `Rent and service charge are payable annually in advance. The service`,
        `charge is not rent — it goes into the fund that runs the building, and is`,
        `accounted for separately.`,
        ...(terms.conditions ? [``, `Conditions of this offer:`, terms.conditions] : []),
        ``,
        `This offer is open until ${offerDate(terms.expiresOn)}. It is an offer of terms`,
        `and does not create a tenancy: no tenancy exists until you accept and the`,
        `sum above is received in cleared funds.`,
        ``,
        `To accept or decline, open this link:`,
        acceptUrl,
        ``,
        `Accepting sets up your tenant account, and the tenancy agreement is then`,
        `issued for signature. If anything above does not match what was discussed,`,
        // ⚠️ Deliberate. Advance-fee fraud against prospective tenants is
        // ordinary in this market, and the defence is a person who knows what
        // the real figures are and expects to be told them in writing first.
        `reply to this email BEFORE paying anything and we will correct it.`,
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
  });
  return res.sent;
}

/** 3 — Accepted. The portal invitation, which acceptance is what creates. */
export async function sendOfferAcceptedInvitation(
  a: ApplicantRef,
  inviteUrl: string,
  unitLabel: string | null
): Promise<boolean> {
  const res = await sendEmail({
    to: a.email,
    orgId: a.orgId,
    category: "account",
    entityType: "invitation",
    entityId: a.applicationId,
    subject: (ctx: MailContext) => `Your ${ctx.brandName} tenancy — setting up your account`,
    text: (ctx: MailContext) =>
      [
        `Dear ${a.name},`,
        ``,
        `Thank you for accepting the offer${unitLabel ? ` on ${unitLabel}` : ""}. It is recorded, and`,
        `the letting team has been notified.`,
        ``,
        `Set up your tenant account here:`,
        inviteUrl,
        ``,
        `This link expires in 14 days and can only be used once.`,
        ``,
        `From your account you can see your tenancy, your rent and service-charge`,
        `statements, pay them, and raise anything that needs attention in the`,
        `building. The tenancy agreement will be issued to you for signature.`,
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
  });
  return res.sent;
}

/** 4 — Not this time. Never sent before 0263; a silent rejection is not one. */
export async function sendRejectionNotice(
  a: ApplicantRef,
  reason: string
): Promise<boolean> {
  const res = await sendEmail({
    to: a.email,
    orgId: a.orgId,
    category: "account",
    entityType: "tenant_application",
    entityId: a.applicationId,
    subject: (ctx: MailContext) => `Your ${ctx.brandName} tenancy application`,
    text: (ctx: MailContext) =>
      [
        `Dear ${a.name},`,
        ``,
        `Thank you for applying. We are sorry to say that on this occasion your`,
        `application has not been successful.`,
        ``,
        `The reason recorded by the reviewer:`,
        ``,
        reason.trim(),
        ``,
        // Decision 10: the decision is human, it is reasoned, and the reason is
        // contestable. All three are worth stating to the person it is about,
        // and the NDPA right to object is not a right anybody can use if they
        // are not told a decision was made.
        `This decision was made by our staff, not by an automated system, and the`,
        `reason above is the reviewer's own. If you believe it rests on something`,
        `incorrect, reply to this email and ask us to look again — say what you`,
        `think is wrong and we will review it.`,
        ``,
        `We keep unsuccessful applications for 90 days and then delete them,`,
        `including the documents you uploaded. You are welcome to apply again for`,
        `another property.`,
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
  });
  return res.sent;
}
