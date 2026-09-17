import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail, type MailContext } from "@/lib/email";
import { sendCascade } from "@/lib/cascade";
import { flattenTemplateVar, firstNameTemplateVar } from "@/lib/notify";
import { formatMoney } from "@/lib/currency";

/**
 * Telling the payer that a payment has been requested of them.
 *
 * ⚠️ Until now, nothing was sent at all. `raisePaymentRequest` created the
 * intent, took a checkout link from the gateway, and copied it to the raiser's
 * CLIPBOARD — so every demand this product has ever raised was delivered by a
 * person pasting it into something else, or not delivered. The Collections
 * screen said "checkout link copied to the clipboard" and that was the whole
 * distribution mechanism.
 *
 * ── Why email is sent separately from the cascade ──────────────────────────
 *
 * `sendCascade` is WhatsApp → SMS → email, stopping at the first success, and
 * its email leg posts a message with the subject "OE Group — notification" from
 * a single `EMAIL_FROM` address. For a payment demand that is wrong twice: the
 * subject line is the thing that gets an invoice opened, and a TFML tenant must
 * not receive anything headed "OE Group" (B1). So:
 *
 *   • the EMAIL goes through `lib/email.ts`, which resolves the org's own brand,
 *     reply-to and sender, and is sent ALWAYS — it is the record, it carries the
 *     full breakdown, and it is what someone forwards to their accounts person;
 *   • the CASCADE runs WhatsApp → SMS as the nudge, with no email leg, so a
 *     failed WhatsApp cannot produce a second, unbranded email beside the good
 *     one.
 *
 * Two messages rather than one, deliberately. A payment demand that arrives only
 * on WhatsApp is easy to lose; one that arrives only by email is easy to miss.
 *
 * ⚠️ Best-effort by construction. The intent and the checkout link already
 * exist when this runs; a mail provider being down must never lose them or turn
 * a raised request into a failure. Everything here is caught, and what actually
 * happened is REPORTED back so the screen can say "emailed to X" rather than
 * implying a delivery that did not occur.
 */

export type PaymentRequestNotice = {
  orgId: string;
  intentId: string | null;
  reference: string;
  /** `service_charge` | `rent` | `deposit` | `other`. */
  purpose: string;
  amount: number;
  currency: string;
  /** "Lake River · Office Suite - 4", when the charge names one. */
  propertyOrUnit: string | null;
  period: string | null;
  dueDate: string | null;
  payerUserId: string | null;
  payerEmail: string | null;
  payerName: string | null;
  /** Absolute, and already resolved by the caller. */
  payLink: string;
};

export type NoticeOutcome = {
  emailed: string | null;
  nudged: "whatsapp" | "sms" | null;
  belled: boolean;
  /** Why nothing could be sent, when nothing could. */
  problem: string | null;
};

const purposeWords = (p: string) =>
  p === "service_charge" ? "service charge"
  : p === "rent" ? "rent"
  : p === "deposit" ? "deposit"
  : "payment";

export async function sendPaymentRequestNotice(
  n: PaymentRequestNotice
): Promise<NoticeOutcome> {
  const out: NoticeOutcome = { emailed: null, nudged: null, belled: false, problem: null };

  // The payer's own contact details, when they are a portal user. An ad-hoc or
  // unassigned collection has only whatever address was typed at checkout.
  let phone: string | null = null;
  let name = n.payerName;
  let email = n.payerEmail;
  if (n.payerUserId) {
    const { data: u } = await supabaseAdmin
      .from("users")
      .select("full_name, email, phone")
      .eq("id", n.payerUserId)
      .maybeSingle();
    if (u) {
      name = name ?? (u.full_name as string | null);
      email = email ?? (u.email as string | null);
      phone = (u.phone as string | null) ?? null;
    }
  }

  if (!email && !phone) {
    out.problem =
      "no email or phone is on file for this payer, so the link could not be sent";
    return out;
  }

  const what = purposeWords(n.purpose);
  const money = formatMoney(n.amount, n.currency);
  const where = n.propertyOrUnit ? ` for ${n.propertyOrUnit}` : "";
  const forPeriod = n.period ? ` (${n.period})` : "";
  const due = n.dueDate
    ? new Date(n.dueDate).toLocaleDateString("en-NG", {
        day: "numeric", month: "long", year: "numeric",
      })
    : null;

  // ── The record: a branded email, always ──────────────────────────────────
  if (email) {
    try {
      const res = await sendEmail({
        to: email,
        orgId: n.orgId,
        category: "finance",
        entityType: "payment_intent",
        entityId: n.intentId,
        subject: (ctx: MailContext) =>
          `${ctx.brandName} — ${what} payment request (${money})`,
        text: (ctx: MailContext) =>
          [
            `Dear ${name ?? "Sir/Madam"},`,
            ``,
            `This is a request for payment of your ${what}${where}${forPeriod}.`,
            ``,
            `Amount due:  ${money}`,
            `Reference:   ${n.reference}`,
            ...(due ? [`Due by:      ${due}`] : []),
            ``,
            `You can pay here:`,
            n.payLink,
            ``,
            // True, and worth saying: `raisePaymentRequest` reads the amount
            // from the invoice and never from the caller, and the webhook
            // verifies server-side before anything is posted.
            `The amount is taken from the invoice itself and cannot be altered at checkout.`,
            `A receipt is sent automatically once the payment is confirmed.`,
            ``,
            `If you have already paid this, or anything here does not look right,`,
            `reply to this email before paying and we will check it.`,
            ``,
            `${ctx.brandName}`,
          ].join("\n"),
      });
      if (res.sent) out.emailed = email;
      else out.problem = `the email was not accepted: ${res.reason ?? "unknown"}`;
    } catch (e) {
      out.problem = e instanceof Error ? e.message : "the email could not be sent";
    }
  }

  // ── The nudge: WhatsApp, falling back to SMS ─────────────────────────────
  //
  // ⚠️ "NGN" rather than the naira sign in the SMS body. U+20A6 is not in
  // GSM-7, so a single ₦ forces the whole message into UCS-2 — which halves the
  // segment length from 160 characters to 70 and silently doubles the cost of
  // every payment reminder the org ever sends.
  const smsMoney = money.replace(/₦/g, "NGN ");
  try {
    const res = await sendCascade({
      orgId: n.orgId,
      entityType: "service_charge",
      entityId: n.intentId,
      recipientUserId: n.payerUserId,
      message:
        `${smsMoney} ${what}${where ? " for " + n.propertyOrUnit : ""} is due. ` +
        `Pay: ${n.payLink} Ref ${n.reference}. Do not share this link.`,
      whatsapp: phone,
      whatsappTemplate: {
        name: "payment_request",
        languageCode: "en",
        variables: [
          firstNameTemplateVar(name),
          flattenTemplateVar(what, "payment", 30),
          flattenTemplateVar(n.propertyOrUnit ?? "your account", "your account"),
          money,
          flattenTemplateVar(n.reference, "the reference", 40),
        ],
      },
      phone,
      // No email leg: the branded one above has already gone, and the cascade's
      // own is unbranded and generically subjected.
      email: null,
    });
    if (res.delivered) out.nudged = phone ? "whatsapp" : "sms";
  } catch {
    // A nudge that fails is not a failure of the request — the email carries it.
  }

  // ── The bell, for a payer who actually has a portal ──────────────────────
  if (n.payerUserId) {
    try {
      await supabaseAdmin.rpc("notify_user", {
        p_user_id: n.payerUserId,
        p_kind: "payment_request",
        p_title: `Payment requested — ${money}`,
        p_body: `${what.charAt(0).toUpperCase()}${what.slice(1)}${where}${forPeriod}. Reference ${n.reference}.`,
        // Relative, as notify_user requires. Their own statement, which lists
        // the charge and carries its own pay button — rather than the gateway
        // link, which is external and expires.
        p_link: "/dashboard/statements",
        p_entity_type: "payment_intent",
        p_entity_id: n.intentId,
      });
      out.belled = true;
    } catch {
      // The bell is the least of the three; never worth failing over.
    }
  }

  return out;
}
