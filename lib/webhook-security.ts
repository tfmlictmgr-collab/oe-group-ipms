import crypto from "node:crypto";

// Webhook payload authentication. This is the ONLY auth these public endpoints
// have — RLS does not apply because the intake handlers write with the service
// role. So the fail-open behaviour that was convenient for the POC is a live
// abuse/amplification risk in production (forged POSTs create tickets, spend
// Anthropic tokens, and make our verified number send replies to arbitrary
// recipients).
//
// Policy:
//   • secret configured        → enforce (verify the signature/token).
//   • secret missing + prod     → FAIL CLOSED (reject). Set the secret in the
//                                 host env or the endpoint stays closed.
//   • secret missing + non-prod → skip with a warning (local/POC convenience).
//
// "Production" = VERCEL_ENV === "production" (Vercel prod deploy) OR, off
// Vercel, NODE_ENV === "production". Preview/dev deploys still skip so demos
// keep working without the secret.

type Result = { ok: boolean; reason?: string };

function isProduction(): boolean {
  const vercelEnv = process.env.VERCEL_ENV; // "production" | "preview" | "development"
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
}

// Shared handling for the "no secret configured" case.
function missingSecret(name: string): Result {
  if (isProduction()) {
    return { ok: false, reason: `rejected: ${name} not set in production (fail-closed)` };
  }
  return { ok: true, reason: `skipped: ${name} not set (non-production)` };
}

// WhatsApp Cloud API signs each POST with the App Secret:
//   X-Hub-Signature-256: sha256=<hmac hex of the raw body>
export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null
): Result {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return missingSecret("WHATSAPP_APP_SECRET");
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

// Telegram auth moved to per-bot routing: the x-telegram-bot-api-secret-token
// header is matched against a channel_routes row (see lib/channel-routing.ts),
// which both authenticates the request and resolves its org. That replaced the
// single-secret verifyTelegramSecret() this module used to export.
