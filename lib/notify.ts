const WHATSAPP_API_VERSION = "v20.0";

export async function sendReply(
  channel: "whatsapp" | "telegram",
  chatId: string,
  text: string
) {
  if (channel === "whatsapp") {
    const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: chatId,
        type: "text",
        text: { body: text },
      }),
    });
    if (!response.ok) {
      throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

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
