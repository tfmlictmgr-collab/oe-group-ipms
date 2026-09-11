// Click-to-chat deep links.
//
// The point of this file is that a tenant, vendor or applicant should never be
// asked to read, type, dial or save a phone number to reach an org on WhatsApp.
// They tap a link; WhatsApp opens already addressed, already introduced.
//
// ⚠️ What this deliberately is NOT: number masking. The WhatsApp Business
// Platform has no proxy-number mechanism — every inbound message lands on a
// real, WABA-registered number, and anything advertising otherwise is either
// describing click-to-chat or running off-spec in a way that gets the WABA
// banned. So the number is not hidden; it is simply never something a person
// has to handle. Keep it out of printed marketing copy and this holds.

/**
 * E.164 digits, no '+', no spaces, no punctuation — the exact shape wa.me
 * wants, and the shape `orgs.whatsapp_number`'s CHECK constraint enforces.
 *
 * Accepts the forms a human actually pastes into a settings field
 * ('+234 703 689 1329', '0703 689 1329' with a country code supplied) and
 * returns null for anything it cannot be sure of, because a half-parsed number
 * produces a link that silently opens a chat with the WRONG person.
 */
export function normalizeWhatsAppNumber(
  input: string | null | undefined,
  defaultCountryCode = "234"
): string | null {
  const raw = input?.trim();
  if (!raw) return null;

  // Strip everything that is not a digit, keeping track of whether the caller
  // wrote an explicit international prefix.
  const hadPlus = raw.startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // A national-format Nigerian number ('0703...') is the single most likely
  // thing an admin pastes. Only rewrite it when there was no '+' — with an
  // explicit prefix the leading digits are the country code and must be left
  // exactly alone.
  if (!hadPlus && digits.startsWith("0")) {
    digits = defaultCountryCode + digits.slice(1);
  }

  // E.164: 7–15 digits, and a country code never starts at zero.
  if (!/^[1-9][0-9]{6,14}$/.test(digits)) return null;
  return digits;
}

/** Formatting for display only — never round-trip this back into a link. */
export function formatWhatsAppNumber(e164: string | null | undefined): string | null {
  const n = normalizeWhatsAppNumber(e164);
  return n ? `+${n}` : null;
}

export type ChatLinkOptions = {
  /**
   * Prefilled first message. This is the half that makes the link worth having
   * over a bare number: it carries the context the org would otherwise have to
   * ask for ("about ticket TFML-1042"), so the conversation starts already
   * placed rather than with "hi, who is this."
   */
  message?: string | null;
};

/**
 * The maximum prefilled message length. WhatsApp itself does not document a
 * hard limit for the `text` parameter, but URLs get truncated by messaging
 * apps, email clients and QR encoders long before WhatsApp complains, and a
 * truncated prefill is worse than a short one — it opens the chat with half a
 * sentence the user then has to finish or delete.
 */
const MAX_PREFILL = 300;

/**
 * Builds a wa.me click-to-chat URL, or null when the org has no number
 * registered.
 *
 * Returning null rather than throwing is deliberate: every caller is a UI
 * surface that should simply not render a WhatsApp affordance for an org that
 * has no WhatsApp, and an exception here would take down a ticket page over a
 * missing optional contact method.
 */
export function whatsAppChatLink(
  number: string | null | undefined,
  options: ChatLinkOptions = {}
): string | null {
  const e164 = normalizeWhatsAppNumber(number);
  if (!e164) return null;

  const message = options.message?.trim().slice(0, MAX_PREFILL);
  // encodeURIComponent, not URLSearchParams: the latter encodes spaces as '+',
  // which WhatsApp renders literally as plus signs in the prefilled box.
  return message
    ? `https://wa.me/${e164}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${e164}`;
}

/**
 * The prefill for a message about one specific ticket.
 *
 * The reference is included as plain text the person can see before sending,
 * not as a hidden token — they are about to send this message under their own
 * name, and a link that silently posts an opaque identifier on their behalf is
 * the kind of thing that erodes trust in the channel.
 */
export function ticketChatMessage(reference: string, portalName: string): string {
  return `Hello ${portalName}, I'd like to ask about request ${reference}.`;
}

/** The prefill for a general enquiry — no reference to attach yet. */
export function generalChatMessage(portalName: string): string {
  return `Hello ${portalName}, I'd like some help.`;
}
