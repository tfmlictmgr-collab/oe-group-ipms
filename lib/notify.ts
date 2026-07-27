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

export async function sendTelegram(chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
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
  sender?: WhatsAppSender | null
) {
  if (channel === "whatsapp") {
    if (!sender) {
      throw new Error(
        "no WhatsApp sending number for this conversation — refusing to answer from another brand's number"
      );
    }
    return sendWhatsApp(sender, chatId, text);
  }
  return sendTelegram(chatId, text);
}
