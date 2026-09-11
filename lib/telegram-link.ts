// Click-to-chat deep links for Telegram — the sibling of `whatsapp-link.ts`,
// and the same goal: nobody should have to search for, type, or be told a bot
// handle to reach an org.
//
// ⚠️ THE SECURITY SPLIT, because it is the whole reason this file can exist.
// A Telegram bot has two identifiers and only one of them is publishable:
//
//   • the USERNAME (`@tfml_support_bot`) — public by construction. Telegram
//     exposes it to every person who has ever talked to the bot, it is
//     searchable, and it grants nothing. That is what this file handles.
//   • the TOKEN — the bot's entire authority. It is `channel_routes`'
//     per-bot secret, which 0039 locked to the service role after finding a
//     tenant could read it ("Anyone holding it can forge inbound service
//     requests against the org, choose which org they land in, and attribute
//     them to any sender"). It must never reach a client component, and
//     nothing here touches it.
//
// So the username lives on `orgs` beside the other public branding fields, and
// the token stays exactly where 0039 put it.

/**
 * A bare bot username — no '@', no URL, no whitespace.
 *
 * Telegram's own rule: 5–32 characters, letters/digits/underscores, and a bot's
 * username must end in 'bot' (case-insensitive). That last part is enforced
 * here because it is a cheap way to catch the most likely admin mistake —
 * pasting a personal @handle or a channel name into the field, which would
 * point every "chat with us" link in the portal at a stranger.
 */
export function normalizeTelegramUsername(
  input: string | null | undefined
): string | null {
  let v = input?.trim();
  if (!v) return null;

  // Accept the three shapes an admin plausibly pastes: '@name', a t.me URL, or
  // the bare handle.
  v = v.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "");
  v = v.replace(/^@/, "");
  // A pasted deep link may carry a ?start= payload; the handle is what matters.
  v = v.split(/[/?#]/)[0];

  if (!/^[A-Za-z0-9_]{5,32}$/.test(v)) return null;
  if (!/bot$/i.test(v)) return null;
  return v;
}

/** Display form, with the '@' people expect to see. */
export function formatTelegramUsername(
  username: string | null | undefined
): string | null {
  const u = normalizeTelegramUsername(username);
  return u ? `@${u}` : null;
}

/**
 * The `?start=` payload is limited by Telegram to 64 characters of
 * `A-Za-z0-9_-`. Anything outside that set silently breaks the link rather
 * than being escaped, so the payload is validated rather than encoded.
 */
const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type TelegramLinkOptions = {
  /**
   * Deep-link payload, delivered to the bot as `/start <payload>` on the
   * person's FIRST message.
   *
   * ⚠️ This arrives from an untrusted client and is trivially editable in the
   * URL bar before sending — exactly the property `notify.ts` already warns
   * about for callback data: "A button is a suggestion, never an
   * authorisation." Treat a start payload the same way. It may carry a
   * reference to look up; the handler MUST then re-check that whatever it
   * names belongs to the org the webhook resolved, and it must never be the
   * thing that grants access.
   */
  startPayload?: string | null;
};

/**
 * Builds a t.me deep link, or null when the org has no bot registered.
 *
 * Null rather than throwing, for the same reason as the WhatsApp builder: a UI
 * surface should simply not offer a Telegram affordance for an org without
 * Telegram, and both live orgs are in exactly that state right now — the TFML
 * and OEA bots are still uncreated in @BotFather (GO_LIVE_CHECKLIST.md §1). So
 * this returning null is the expected path today, not an error case.
 */
export function telegramChatLink(
  username: string | null | undefined,
  options: TelegramLinkOptions = {}
): string | null {
  const handle = normalizeTelegramUsername(username);
  if (!handle) return null;

  const payload = options.startPayload?.trim();
  if (payload && START_PAYLOAD_RE.test(payload)) {
    return `https://t.me/${handle}?start=${payload}`;
  }
  // An invalid payload drops to the plain link rather than producing a broken
  // one. The person still reaches the right bot; they just introduce themselves
  // in their own words.
  return `https://t.me/${handle}`;
}

/**
 * A start payload naming one ticket.
 *
 * Deliberately the human-facing reference (`TFML-1042`), not a database id or
 * a token: it is visible in the URL, it is guessable by design, and it is
 * therefore only ever a hint about what the conversation is about. The bot
 * still has to resolve it within the org the webhook authenticated, and still
 * has to check the sender is entitled to see it.
 */
export function ticketStartPayload(reference: string): string | null {
  const p = reference.trim().replace(/[^A-Za-z0-9_-]/g, "");
  return p && p.length <= 64 ? p : null;
}
