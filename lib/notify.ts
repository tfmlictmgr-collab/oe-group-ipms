import { supabaseAdmin } from "./supabase/admin";

// 360dialog's WhatsApp Business API host. Both brands' numbers are provisioned
// through it, so this — not graph.facebook.com — is where sends go.
const WHATSAPP_360D_BASE = "https://waba-v2.360dialog.io";

// Outbound messaging.
//
// A WhatsApp reply MUST leave from the number it arrived on. The sender used to
// be a single `WHATSAPP_PHONE_NUMBER_ID` environment variable, so once two
// numbers were live every reply went out from whichever one that variable named
// — a person who messaged OEA got their answer from TFML, in the TFML thread.
// Inbound routing was already per-number (0011); only the outbound half was
// global, and a four-layer isolation model is worth nothing if the reply
// crosses brands.
//
// The sending number is therefore always passed in explicitly. There is no
// default and no env fallback for WHICH NUMBER: a fallback is precisely how the
// wrong brand answers, and it fails silently because the message does get
// delivered.
//
// ⚠️ The TOKEN is a separate question from the number, and the answer changed.
// The comment this replaced said Meta issues one System User token per business,
// covering every number under it — true for a single native Meta Business
// Manager holding both brands. It stopped being true the moment TFML and OEA
// became separate businesses on a BSP (360dialog), each with its own API key:
// one shared token can no longer answer for both. The token therefore now
// belongs beside the route (`channel_routes.outbound_token`, service-role-only
// since 0039 — the same column Telegram's per-bot tokens already use, 0047),
// with the single shared env var kept only as the fallback for an org that has
// not been migrated to a per-route credential yet.

export type WhatsAppSender = {
  phoneNumberId: string;
  /**
   * Either the per-route credential this number was registered with
   * (`register-whatsapp-number.mjs`, one key per business on a BSP), or the
   * single shared System User token when the org's route predates per-route
   * credentials. Never both consulted for the same number — whichever
   * `channel_routes` row names is authoritative.
   */
  accessToken: string;
};

/**
 * The number this org answers from, or null if it has none registered.
 *
 * This is only the fallback for messages WE initiate (e.g. a payment
 * notification). A reply always uses the exact number the message arrived on —
 * see `whatsappSenderForNumber` — because an org holding more than one line
 * must not have a proactive-message default stand in for "the number someone
 * actually wrote to."
 */
export async function whatsappSenderForOrg(orgId: string): Promise<WhatsAppSender | null> {
  // Ordered, not merely limited, for the same reason `channel_sender_for_org`
  // documents for Telegram: an org may hold more than one number, and
  // `limit(1)` with no ORDER BY lets the planner decide which brand's number a
  // proactive message goes out from.
  const { data, error } = await supabaseAdmin.rpc("channel_sender_for_org", {
    p_org_id: orgId,
    p_channel: "whatsapp",
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.external_id) return null;

  const accessToken = row.outbound_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) return null;
  return { phoneNumberId: row.external_id, accessToken };
}

/**
 * The credential for ONE EXACT number, keyed by its phone_number_id — not the
 * org's default. A reply must leave from the number the message arrived on,
 * which is not necessarily what `whatsappSenderForOrg` would answer once an org
 * holds more than one line: that function picks the org's established number
 * for messages WE initiate, and this one answers the different question "what
 * does this specific route send with," for messages we are replying to.
 */
export async function whatsappSenderForNumber(
  phoneNumberId: string
): Promise<WhatsAppSender | null> {
  const { data, error } = await supabaseAdmin
    .from("channel_routes")
    .select("outbound_token")
    .eq("channel", "whatsapp")
    .eq("external_id", phoneNumberId)
    .maybeSingle();
  if (error || !data) return null;

  const accessToken = data.outbound_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) return null;
  return { phoneNumberId, accessToken };
}

/**
 * Sends one WhatsApp text message.
 *
 * ⚠️ This posts to **360dialog**, the BSP both live numbers now sit behind — not
 * to Meta's Graph API directly. Three things differ from the native Cloud API
 * and all three are load-bearing:
 *
 *   • the host is `waba-v2.360dialog.io`, not `graph.facebook.com`
 *   • the path carries **no phone_number_id** — the API key identifies the
 *     channel, which is precisely why the key must be the per-route one
 *     (`channel_routes.outbound_token`) and never a shared default: with the
 *     number gone from the URL, the credential is the ONLY thing deciding which
 *     brand the message leaves as
 *   • auth is `D360-API-KEY: <key>`, not `Authorization: Bearer <token>`
 *
 * The request body is unchanged — 360dialog mirrors Meta's message schema.
 *
 * `sender.phoneNumberId` is therefore no longer part of the URL. It is retained
 * because it is what the route was looked up BY, and it is worth having in an
 * error message: "send failed" is much harder to place than "send failed for
 * 1261550270372677".
 *
 * If a natively-registered Meta number is ever added back alongside these, this
 * function needs a provider discriminator on `channel_routes` rather than a
 * guess — today every live route is 360dialog, so there is nothing to guess.
 */
export async function sendWhatsApp(sender: WhatsAppSender, to: string, text: string) {
  const response = await fetch(`${WHATSAPP_360D_BASE}/messages`, {
    method: "POST",
    headers: {
      "D360-API-KEY": sender.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `WhatsApp send failed from ${sender.phoneNumberId}: ${response.status} ${await response.text()}`
    );
  }
  return response.json();
}

/**
 * Sends a PRE-APPROVED TEMPLATE message — the only thing WhatsApp permits when
 * the org is speaking first.
 *
 * ⚠️ THE 24-HOUR WINDOW, which `sendWhatsApp` above silently depends on.
 * WhatsApp allows free-form text only inside a 24-hour "customer service
 * window" opened by the person messaging the org. Outside it — which is every
 * message WE initiate to someone who has not written in today — a `type:
 * "text"` send is REJECTED by the API. It does not degrade, it does not queue,
 * and the failure is at send time rather than anywhere a reader of the calling
 * code would expect it.
 *
 * That matters because the whole point of business-initiated messaging here is
 * that the org opens the conversation, so the tenant never has to find a number
 * at all. Doing that requires this function; `sendWhatsApp` cannot do it, and
 * any proactive notification currently routed through it works only by the
 * accident of the recipient having messaged in recently.
 *
 * A template must be registered and approved in the 360dialog Hub BEFORE it can
 * be sent — approval takes minutes to a day, and an unapproved name fails the
 * same way a typo'd one does. `name` and `languageCode` must match the approved
 * template exactly.
 *
 * `variables` fill the template's `{{1}}`, `{{2}}` … placeholders IN ORDER.
 * They are the only free text in the message, and WhatsApp rejects newlines,
 * tabs and runs of 5+ spaces inside them — so a variable carrying, say, a
 * multi-line address fails the whole send. Callers should pass short, flat
 * values — see `flattenTemplateVar` below.
 */
export async function sendWhatsAppTemplate(
  sender: WhatsAppSender,
  to: string,
  template: { name: string; languageCode: string; variables?: string[] }
) {
  const variables = template.variables ?? [];
  const response = await fetch(`${WHATSAPP_360D_BASE}/messages`, {
    method: "POST",
    headers: {
      "D360-API-KEY": sender.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.languageCode },
        ...(variables.length
          ? {
              components: [
                {
                  type: "body",
                  parameters: variables.map((text) => ({ type: "text", text })),
                },
              ],
            }
          : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `WhatsApp template "${template.name}" failed from ${sender.phoneNumberId}: ` +
        `${response.status} ${await response.text()}`
    );
  }
  return response.json();
}

/**
 * Prepares a value for a `sendWhatsAppTemplate` variable. WhatsApp rejects
 * the WHOLE send if any variable carries a newline, a tab, or a run of 5+
 * spaces (WHATSAPP_TEMPLATES.md §0) — likely from a copy-pasted description
 * or a multi-line address — so this collapses whitespace and caps length
 * once, here, rather than trusting every call site to remember to.
 *
 * `fallback` covers the property-missing / name-missing case each template
 * already had a bespoke fallback for in free-text form (e.g. "your
 * property"); a template with an EMPTY variable is a different failure mode
 * than free text with a blank spot — WhatsApp rejects a body that would
 * start or end on a variable if it resolves empty, so a caller must never
 * hand this a value that can be "".
 */
export function flattenTemplateVar(
  value: string | null | undefined,
  fallback: string,
  maxLen = 60
): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  const withFallback = flat || fallback;
  return withFallback.length > maxLen ? `${withFallback.slice(0, maxLen - 1)}…` : withFallback;
}

/**
 * The `{{1}}` greeting name several templates share ("recipient's first
 * name" — `users.full_name`, first word, per WHATSAPP_TEMPLATES.md §1/§3).
 * Separate from `flattenTemplateVar` because taking the first word is a
 * different operation from flattening whitespace, not a stricter version of
 * it — a caller that wants the whole cleaned name (`payment_approved`'s
 * `vendors.name`, a company name) must use `flattenTemplateVar` instead.
 */
export function firstNameTemplateVar(fullName: string | null | undefined, fallback = "there"): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || fallback;
}

/**
 * A row of tappable buttons. Telegram sends the `data` string back as a
 * `callback_query` when one is pressed.
 *
 * `data` is caller-supplied and comes back from an untrusted client, so every
 * handler MUST re-check that whatever it names belongs to the org the webhook
 * resolved. A button is a suggestion, never an authorisation.
 */
export type TelegramButton = { label: string; data: string };

/** The bot an org replies as. Null when it has no Telegram identity. */
export async function telegramSenderForOrg(orgId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("channel_sender_for_org", {
    p_org_id: orgId,
    p_channel: "telegram",
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  // Falls back to the single-bot environment variable so an org configured
  // before per-bot tokens existed keeps working.
  return row?.outbound_token ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
}

export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  buttons?: TelegramButton[][]
) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(buttons?.length
        ? {
            reply_markup: {
              inline_keyboard: buttons.map((row) =>
                row.map((b) => ({ text: b.label, callback_data: b.data }))
              ),
            },
          }
        : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Clears the spinner on a tapped button. Telegram shows it until this is
 * answered, so skipping it leaves the person looking at a hung message even
 * when the work succeeded.
 */
export async function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  text?: string
) {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  }).catch(() => {});
}

/**
 * Replies on a conversation.
 *
 * For WhatsApp, `sender` is REQUIRED and should be the number that received the
 * message — passed through rather than looked up, because answering on the exact
 * number a person wrote to stays correct even where one org holds several.
 */
export async function sendReply(
  channel: "whatsapp" | "telegram",
  chatId: string,
  text: string,
  sender?: WhatsAppSender | null,
  telegramBotToken?: string | null,
  buttons?: TelegramButton[][]
) {
  if (channel === "whatsapp") {
    if (!sender) {
      throw new Error(
        "no WhatsApp sending number for this conversation — refusing to answer from another brand's number"
      );
    }
    return sendWhatsApp(sender, chatId, text);
  }
  if (!telegramBotToken) {
    // Same rule as WhatsApp: silence is better than the wrong brand answering.
    throw new Error(
      "no Telegram bot for this organisation — refusing to answer as another brand's bot"
    );
  }
  return sendTelegram(telegramBotToken, chatId, text, buttons);
}
