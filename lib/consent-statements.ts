// The consent wording, and nothing else.
//
// ⚠️ THIS FILE MUST IMPORT NOTHING SERVER-SIDE, and that is why it exists
// separately from `lib/channel-consent.ts`.
//
// The statements are rendered by the settings screen, which is a CLIENT
// component, and read by the send gate, which is server-only. The gate lives
// beside `supabaseAdmin` — the service-role client whose own header says
// "never import this into client components." Keeping the strings here means
// the client half can render them without dragging the admin client into the
// browser bundle.
//
// (Next.js strips non-`NEXT_PUBLIC_` environment variables from client
// bundles, so a stray import would not have leaked the service key — but the
// rule is not "avoid leaks you can prove"; it is that a service-role module has
// no business in code shipped to a browser at all.)

export type ConsentChannel = "whatsapp" | "telegram" | "sms" | "email";

/**
 * The wording shown when asking for consent. Kept in one place so a single edit
 * changes the screen, and so the string written to
 * `channel_consents.statement` is provably the string that was displayed.
 *
 * ⚠️ Editing this does NOT retroactively change what anyone agreed to — every
 * consent row stored the wording current at the time, exactly as
 * `tenant_applications.consent_statement` does (0062). That is the whole point
 * of copying the text rather than referencing it.
 *
 * But it does mean a MATERIAL change of meaning is a NEW consent to be
 * re-collected, not a silent edit: the people who agreed to the old wording
 * never saw this one. Fixing a typo is fine; widening what the message covers
 * is not.
 */
export const CONSENT_STATEMENTS: Record<ConsentChannel, string> = {
  whatsapp:
    "I agree to receive service messages about my tenancy, requests and payments " +
    "on WhatsApp at the number I have provided. I understand these are not " +
    "marketing messages, that I can withdraw this at any time in Settings, and " +
    "that withdrawing does not stop me receiving the same notices by email.",
  telegram:
    "I agree to receive service messages about my tenancy, requests and payments " +
    "on Telegram. I understand these are not marketing messages, that I can " +
    "withdraw this at any time in Settings, and that withdrawing does not stop " +
    "me receiving the same notices by email.",
  sms:
    "I agree to receive service messages about my tenancy, requests and payments " +
    "by SMS at the number I have provided. I understand these are not marketing " +
    "messages and that I can withdraw this at any time in Settings.",
  email:
    "I agree to receive service messages about my tenancy, requests and payments " +
    "by email. Notices I am contractually owed — statements, invoices and " +
    "decisions — will still be sent to me by email.",
};
