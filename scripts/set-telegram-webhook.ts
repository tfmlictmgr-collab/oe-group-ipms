// Registers our live Vercel URL as the Telegram bot's webhook target.
// Usage: npx tsx scripts/set-telegram-webhook.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const token = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = process.env.PUBLIC_APP_URL ?? "https://oe-group-ipms.vercel.app";

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set in .env.local");
}

const webhookUrl = `${publicUrl}/api/webhooks/telegram`;

async function main() {
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const result = await response.json();
  console.log(result);

  if (!result.ok) {
    throw new Error(`Telegram setWebhook failed: ${result.description}`);
  }

  console.log(`Telegram webhook registered: ${webhookUrl}`);
}

main();
