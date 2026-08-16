// Per-org gateway credentials: encryption, and the resolution that uses them.
//
// ⚠️ The key lives HERE, in the application environment, and never in the
// database. That is the whole design decision. Supabase Vault would have been
// less code, but anything holding the service-role key can read
// `vault.decrypted_secrets` — which would make "a leaked service-role key" and
// "a leaked set of live payment keys" the same event. The service role is used
// throughout the money paths and `.env.local` sits on more than one machine, so
// the two are worth keeping apart: a database compromise alone must not confer
// the ability to charge cards or move a merchant balance.
//
// Consequence, stated plainly: LOSING `GATEWAY_CREDENTIAL_KEY` MEANS EVERY
// STORED CREDENTIAL IS UNRECOVERABLE and each org must paste its keys again.
// That is the correct trade — the alternative is a database that can decrypt
// its own secrets — but it means the key belongs in Infisical with the rest of
// the vault, not only in a `.env.local`.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

/** 32 bytes, base64. Generate with: openssl rand -base64 32 */
function masterKey(): Buffer {
  const raw = process.env.GATEWAY_CREDENTIAL_KEY;
  if (!raw) {
    throw new Error(
      "GATEWAY_CREDENTIAL_KEY is not set — per-org gateway credentials cannot be read or written."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `GATEWAY_CREDENTIAL_KEY must decode to 32 bytes, got ${key.length}. Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

export function credentialKeyConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/** `iv:tag:ciphertext`, all base64. A random IV per encryption, never reused. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored gateway credential is malformed.");
  }
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, "base64"));
  // GCM: the auth tag is what makes this tamper-evident rather than merely
  // scrambled. A modified ciphertext throws here instead of yielding a wrong key
  // that would be sent to Paystack as a live credential.
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Which account a key belongs to, from its own prefix.
 *
 * Both gateways distinguish test from live purely by which key is used — same
 * endpoints, same responses. Recording the mode at save time is what lets the
 * UI say "this is a LIVE key" without ever reading the key again.
 */
export function keyMode(secretKey: string): "test" | "live" | null {
  if (/^sk_test_/.test(secretKey) || /FLWSECK_TEST/.test(secretKey)) return "test";
  if (/^sk_live_/.test(secretKey) || /^FLWSECK-/.test(secretKey)) return "live";
  return null;
}

export function lastFour(secretKey: string): string {
  return secretKey.slice(-4);
}

export type OrgGatewayCredential = {
  gateway: "paystack" | "flutterwave";
  secretKey: string;
  publicKey: string | null;
  webhookSecret: string | null;
  keyMode: "test" | "live";
};

/**
 * The org's own credential for a gateway, decrypted — or null if it has none.
 *
 * Null means "fall back to the platform key", which is what keeps this additive:
 * an org that has not connected its own account keeps working exactly as it did
 * before 0156. It is NOT a silent downgrade, because an org that HAS connected
 * one never reaches the fallback.
 */
export async function getOrgCredential(
  orgId: string,
  gateway: "paystack" | "flutterwave"
): Promise<OrgGatewayCredential | null> {
  if (!credentialKeyConfigured()) return null;

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data } = await supabaseAdmin
    .from("org_gateway_credentials")
    .select("gateway, public_key, secret_key_enc, webhook_secret_enc, key_mode")
    .eq("org_id", orgId)
    .eq("gateway", gateway)
    .eq("active", true)
    .maybeSingle();

  if (!data) return null;

  return {
    gateway,
    secretKey: decryptSecret(data.secret_key_enc),
    publicKey: data.public_key,
    webhookSecret: data.webhook_secret_enc ? decryptSecret(data.webhook_secret_enc) : null,
    keyMode: data.key_mode as "test" | "live",
  };
}

/**
 * The org that minted a payment reference, from the tag inside it.
 *
 * ⚠️ Called on an UNVERIFIED webhook payload, deliberately. Using an unverified
 * field to CHOOSE WHICH KEY TO VERIFY WITH is safe: a forged payload naming
 * another org's tag gets checked against that org's secret and fails. The
 * choice cannot be exploited because a wrong choice refuses. Nothing else in
 * that payload is trusted.
 *
 * Returns null for references minted before 0156 — those must keep verifying
 * against the platform key, or every in-flight payment breaks on deploy.
 */
export async function orgFromPaymentReference(reference: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data } = await supabaseAdmin.rpc("payment_reference_org_tag", { p_reference: reference });
  return (data as string | null) ?? null;
}
