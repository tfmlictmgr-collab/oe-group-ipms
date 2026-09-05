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

/**
 * HMAC-SHA256 of the raw body, compared in constant time.
 *
 * The comparison must not short-circuit on the first differing byte: a timing
 * oracle on a signature check is how a forger recovers a valid one byte at a
 * time. `timingSafeEqual` throws on unequal lengths, hence the explicit guard
 * before it — that guard leaks only the LENGTH, which is fixed and public for a
 * hex SHA-256 anyway.
 *
 * The presented value may carry a `sha256=` prefix (Meta always does; BSPs
 * vary), so it is normalised away rather than assumed either way. Tolerating the
 * two spellings costs nothing — the full digest is still compared.
 */
function hmacMatches(rawBody: string, secret: string, presented: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const offered = presented.trim().replace(/^sha256=/i, "");
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Compares a presented shared secret with the expected one, in constant time.
 *
 * ⚠️ Audit 0804 E1. The two cron job routes compared their bearer token with
 * `===`, which returns as soon as two bytes differ — the exact pattern
 * `hmacMatches` above exists to avoid, reintroduced two files away from its own
 * reasoning. A remote timing oracle on a job secret is a stretch (network jitter
 * dominates, and the secret gates a billing run rather than data), but the fix
 * costs one function call and the inconsistency is what actually causes harm:
 * a codebase where the safe comparison is sometimes used teaches nobody which
 * one to reach for.
 *
 * Both values are hashed first, so unequal LENGTHS cannot leak either — unlike a
 * signature, a shared secret's length is not public.
 */
export function secretMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
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

  return hmacMatches(rawBody, secret, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/**
 * Authenticates an inbound WhatsApp webhook, whichever provider forwarded it.
 *
 * ⚠️ **A BSP does not relay Meta's signature.** When TFML and OEA moved onto
 * 360dialog, the POST that reaches us is 360dialog's own, signed with 360dialog's
 * own scheme — `x-360dialog-signature`, HMAC-SHA256 of the raw body under the
 * Platform Secret, with no `X-Hub-Signature-256` present at all. The Meta-only
 * verifier would therefore have rejected every real message with a 403 while
 * routing, tokens and display names all looked correct: inbound simply stops,
 * and nothing in the failure names the cause.
 *
 * Both schemes are supported rather than one replacing the other, because a
 * number can sit on either path — a BSP channel today, a natively-registered
 * number tomorrow — and which one signed a given request is knowable from the
 * request itself. The header decides which secret is consulted; a request
 * bearing neither is unauthenticated and treated exactly as before.
 */
export function verifyWhatsAppInbound(
  rawBody: string,
  headers: Headers
): Result {
  const dialogSignature = headers.get("x-360dialog-signature");
  if (dialogSignature) {
    const secret = process.env.WHATSAPP_360D_SIGNING_SECRET;
    if (!secret) return missingSecret("WHATSAPP_360D_SIGNING_SECRET");
    return hmacMatches(rawBody, secret, dialogSignature)
      ? { ok: true }
      : { ok: false, reason: "360dialog signature mismatch" };
  }

  const metaSignature = headers.get("x-hub-signature-256");
  if (metaSignature) return verifyWhatsAppSignature(rawBody, metaSignature);

  // No signature of either kind. Same policy as a missing secret: refuse in
  // production, allow locally. Naming both headers matters — "missing
  // X-Hub-Signature-256" sent someone hunting through Meta's app settings for a
  // problem that lived in the BSP's webhook configuration.
  if (isProduction()) {
    return {
      ok: false,
      reason: "rejected: no x-360dialog-signature or x-hub-signature-256 (fail-closed)",
    };
  }
  return { ok: true, reason: "skipped: request carried no signature (non-production)" };
}

// Telegram auth moved to per-bot routing: the x-telegram-bot-api-secret-token
// header is matched against a channel_routes row (see lib/channel-routing.ts),
// which both authenticates the request and resolves its org. That replaced the
// single-secret verifyTelegramSecret() this module used to export.
