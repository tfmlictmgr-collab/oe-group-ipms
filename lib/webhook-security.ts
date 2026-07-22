import crypto from "node:crypto";

// Webhook payload authentication. Both verifiers enforce when their secret is
// configured and *skip with a warning* when it isn't — so the POC runs without
// the secrets, but the moment they're set (production) the endpoints are
// protected against forged payloads. This is the only auth these public
// endpoints have; RLS does not apply because writes use the service role.

type Result = { ok: boolean; reason?: string };

// WhatsApp Cloud API signs each POST with the App Secret:
//   X-Hub-Signature-256: sha256=<hmac hex of the raw body>
export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null
): Result {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return { ok: true, reason: "skipped: WHATSAPP_APP_SECRET not set" };
  if (!signatureHeader) return { ok: false, reason: "missing X-Hub-Signature-256" };

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

// Telegram echoes the secret_token set on setWebhook as a header on every POST.
export function verifyTelegramSecret(headerToken: string | null): Result {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return { ok: true, reason: "skipped: TELEGRAM_WEBHOOK_SECRET not set" };
  return headerToken === secret
    ? { ok: true }
    : { ok: false, reason: "secret token mismatch" };
}
