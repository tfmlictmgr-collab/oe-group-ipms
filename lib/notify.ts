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
// default and no env fallback: a fallback is precisely how the wrong brand
// answers, and it fails silently because the message does get delivered.

export type WhatsAppSender = {
  phoneNumberId: string;
  /**
   * Meta issues one System User token per business and it covers every number
   * under that business — so the token is shared while the number is not. If the
   * brands ever sit under separate WABAs this becomes per-route and belongs in
   * `channel_routes`, which has been service-role-only since 0039.
   */
  accessToken: string;
};

/** The number this org answers from, or null if it has none registered. */
export async function whatsappSenderForOrg(orgId: string): Promise<WhatsAppSender | null> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) return null;

  // Ordered, not just limited. An org may hold more than one number (a second
  // line, a migration in progress), and `limit(1)` with no ORDER BY lets the
  // planner decide which brand's number a proactive message goes out from. The
  // oldest registered route is the org's established number.
  //
  // This is only the fallback for messages WE initiate. A reply always uses the
  // number the message arrived on, passed explicitly by the webhook.
  const { data, error } = await supabaseAdmin
    .from("channel_routes")
    .select("external_id")
    .eq("channel", "whatsapp")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .order("external_id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data?.external_id) return null;
  return { phoneNumberId: data.external_id, accessToken };
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
