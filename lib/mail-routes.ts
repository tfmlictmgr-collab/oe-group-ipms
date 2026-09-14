/**
 * Which inbox a reply to each kind of email reaches.
 *
 * ⚠️ This is the answer to "the From address is `no-reply@notify.<brand>` — so
 * where does 'reply to this email' actually go?" It goes to the `Reply-To`
 * header, which every mainstream mail client honours over `From`. The sending
 * subdomain is deliberately not a mailbox; these are.
 *
 * ⚠️ Pure, and in its own module, for the same reason `lib/tenancy-offer.ts` is
 * split from its token half: `lib/email.ts` imports the service-role client, so
 * a client component importing the rule from there would pull server code into
 * the browser bundle. The SETTINGS form needs this rule live, as somebody types.
 *
 * The reason it needs it at all: an administrator configuring these three boxes
 * could not see what their configuration did. Leaving "Finance / accounts
 * email" blank silently routes every invoice, statement, receipt and
 * payment-request reply into the general support inbox, and nothing on the page
 * said so. Measured on staging — OEA has no `finance_email`, so replies about
 * real money were landing in `info@` beside everything else.
 *
 * One rule, read by the sender and by the screen that configures it, so the two
 * cannot drift.
 */

export type MailCategory = "account" | "finance" | "operations" | "it";

export type MailRoutes = {
  support_email: string | null;
  finance_email: string | null;
  it_email: string | null;
};

export type ReplyRoute = {
  /** The address a reply will reach, or null when the org has none at all. */
  address: string | null;
  /**
   * True only when this category has NO inbox of its own and support caught it.
   * `account` and `operations` route to support by design, so they are never
   * "falling back" — calling that a fallback would ask an administrator to fix
   * something that is already correct.
   */
  fellBack: boolean;
};

export function replyInboxFor(
  category: MailCategory,
  routes: MailRoutes | null
): ReplyRoute {
  if (!routes) return { address: null, fellBack: false };

  const ownInbox =
    category === "finance" ? routes.finance_email
    : category === "it" ? routes.it_email
    : routes.support_email;

  const chosen = ownInbox?.trim() || null;
  if (chosen) return { address: chosen, fellBack: false };

  // Fall back to support rather than sending an unreplyable email.
  const support = routes.support_email?.trim() || null;
  return { address: support, fellBack: support !== null };
}

/** What each category actually carries, for the person choosing an inbox. */
export const CATEGORY_CARRIES: Record<MailCategory, string> = {
  account:
    "Invitations, tenancy applications, offers of tenancy and password resets",
  finance:
    "Invoices, statements, receipts, payment requests and remittance advice",
  operations: "Job and notice updates",
  it: "System and technical notices",
};
