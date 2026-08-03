import { supabaseAdmin } from "./supabase/admin";

const WHATSAPP_API_VERSION = "v20.0";

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

export async function sendWhatsApp(sender: WhatsAppSender, to: string, text: string) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${sender.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sender.accessToken}`,
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
    throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
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
