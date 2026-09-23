"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import {
  encryptSecret, keyMode, lastFour, credentialKeyConfigured,
} from "@/lib/gateway/credentials";

/**
 * Connect an organisation's own payment gateway account.
 *
 * ⚠️ The secret is encrypted HERE, in the application, before it is ever sent
 * to the database — `set_org_gateway_credential` stores ciphertext and cannot
 * decrypt it. That is the point of the design: a database compromise alone must
 * not yield the ability to charge cards or move a merchant balance.
 *
 * Nothing ever reads a stored secret back to a screen. The page shows whether a
 * key is configured, which mode it is in, and its last four characters — enough
 * to answer "is this the one I pasted?" and nothing more.
 */
export async function saveOrgGatewayCredential(input: {
  gateway: "paystack" | "flutterwave";
  secretKey: string;
  publicKey?: string | null;
  webhookSecret?: string | null;
  orgId?: string | null;
}): Promise<ActionResult> {
  const secret = (input.secretKey ?? "").trim();
  const publicKey = (input.publicKey ?? "").trim();
  const webhookSecret = (input.webhookSecret ?? "").trim();

  if (!credentialKeyConfigured()) {
    return fail(
      "This deployment cannot store gateway credentials yet.",
      "GATEWAY_CREDENTIAL_KEY is not set. Generate one with `openssl rand -base64 32` and add it to the environment before connecting an account."
    );
  }

  if (secret.length < 20) {
    return fail("That does not look like a secret key.", "Paste the full key from your gateway dashboard.");
  }

  // ⚠️ A public key pasted into the secret field is the likeliest mistake, and
  // it would half-work: checkout would fail confusingly rather than obviously.
  if (/^pk_/.test(secret) || /^FLWPUBK/.test(secret)) {
    return fail(
      "That is a PUBLIC key, not a secret key.",
      input.gateway === "flutterwave" ? "The secret key starts with FLWSECK." : "The secret key starts with sk_."
    );
  }

  // The key must belong to the gateway it is being saved as. `keyMode` accepts
  // either family, so without this a Paystack key saved under Flutterwave would
  // be stored, reported as connected, and fail at the first checkout.
  const isFlutterwaveKey = /^FLWSECK/.test(secret);
  if ((input.gateway === "flutterwave") !== isFlutterwaveKey) {
    return fail(
      `That is not a ${input.gateway === "flutterwave" ? "Flutterwave" : "Paystack"} secret key.`,
      input.gateway === "flutterwave"
        ? "A Flutterwave secret key starts with FLWSECK_TEST- or FLWSECK-."
        : "A Paystack secret key starts with sk_test_ or sk_live_."
    );
  }

  // ⚠️ Flutterwave proves a webhook with this hash and NOTHING else (Paystack
  // signs with the secret key itself, so its field is optional). And a blank
  // here is not "keep the current one": `set_org_gateway_credential` writes a
  // new row, so the old hash is retired with the old key. Saved without it,
  // every Flutterwave notification for this org would be refused as forged.
  if (input.gateway === "flutterwave" && !webhookSecret) {
    return fail(
      "Flutterwave needs its secret hash as well.",
      "Set a secret hash under Settings → Webhooks in the Flutterwave dashboard and paste the same value here. It must be entered again whenever the key is replaced."
    );
  }

  const mode = keyMode(secret);
  if (!mode) {
    return fail(
      "That key's prefix was not recognised.",
      input.gateway === "flutterwave"
        ? "A Flutterwave secret key starts with FLWSECK_TEST- or FLWSECK-. Check you have pasted the SECRET key."
        : "A Paystack secret key starts with sk_test_ or sk_live_. Check you have pasted the SECRET key and not the public one."
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase.rpc("set_org_gateway_credential", {
    p_gateway: input.gateway,
    p_public_key: publicKey || null,
    p_secret_enc: encryptSecret(secret),
    p_webhook_enc: webhookSecret ? encryptSecret(webhookSecret) : null,
    p_key_mode: mode,
    p_secret_last4: lastFour(secret),
    p_org_id: input.orgId ?? null,
  });
  if (error) return failFromDb(error, "connect this gateway account");

  revalidatePath("/dashboard/settings/banking");
  return ok();
}

/**
 * What the org may know about its own connection. Never the key.
 */
export async function getOrgGatewayStatus(): Promise<
  ActionResult<Array<{
    gateway: string;
    key_mode: string;
    public_key: string | null;
    secret_last4: string | null;
    updated_at: string;
  }>>
> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("org_gateway_status", { p_org_id: null });
  if (error) return failFromDb(error, "read the gateway status");
  return ok((data ?? []) as never);
}
