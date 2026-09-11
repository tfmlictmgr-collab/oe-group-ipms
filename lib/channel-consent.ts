import { supabaseAdmin } from "./supabase/admin";

// The consent gate for BUSINESS-INITIATED messaging (0148).
//
// ── Where the line falls, because it is the whole design ──────────────────
// This gate applies when WE speak first. It does NOT apply to a reply inside a
// conversation the person started: they messaged us, on the number they chose,
// about a thing they raised. Requiring recorded consent to answer someone's own
// question would be both absurd and worse for them — silence in place of a
// reply. `WHATSAPP_TEMPLATES.md` §5 draws the same line for the same reason:
// template when we speak first, text when we answer.
//
// ── Why this is not `users.notify_whatsapp` ──────────────────────────────
// That column is a routing preference. It carries no date, no wording and no
// history, so it cannot evidence consent to a regulator, and it cannot show
// what was permitted on the day something was sent. 0148's header sets this out
// in full.
//
// ── Failing CLOSED, unlike the rest of the notification path ─────────────
// `lib/rate-limit.ts` fails open on purpose ("a limiter outage must not take
// intake down"), and the cascade treats an unavailable channel as a skip. This
// module does the opposite: any doubt means NOT SENT.
//
// The asymmetry is deliberate. A rate limiter failing open risks extra load; a
// consent check failing open sends a message to a person who may have withdrawn
// — an unlawful disclosure under NDPA and a WhatsApp policy breach that puts
// both brands' inbound channel at risk. The cascade falls through to SMS and
// then email, so failing closed costs the CHANNEL, never the NOTICE.

// The statements themselves live in `consent-statements.ts`, which imports
// nothing server-side — the settings screen is a client component and must be
// able to render them without pulling `supabaseAdmin` into the browser bundle.
export { CONSENT_STATEMENTS, type ConsentChannel } from "./consent-statements";
import type { ConsentChannel } from "./consent-statements";

/**
 * May we send this person a business-initiated message on this channel?
 *
 * `identifier` must be the number/handle the message would actually go to.
 * Consent recorded against a different one does not count: numbers are
 * recycled, and a template sent to a reassigned number discloses the previous
 * holder's business to a stranger. `has_channel_consent` enforces the
 * comparison; passing the wrong value here quietly defeats it.
 */
export async function mayContact(
  userId: string,
  channel: ConsentChannel,
  identifier: string | null | undefined
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("has_channel_consent", {
    p_user_id: userId,
    p_channel: channel,
    p_identifier: identifier ?? null,
  });
  // An error is not "no opinion" — it is an unanswered question about whether
  // contacting someone is lawful, and the only safe answer to that is no.
  if (error) return false;
  return data === true;
}

