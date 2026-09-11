import type { SupabaseClient } from "@supabase/supabase-js";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { portalOrigin } from "@/lib/portal-origin";
import { GatewayNotConnectedError, resolveOrgGateway } from "./index";
import { settleIntentByReference } from "./settle";

export type CheckoutResult = {
  reference: string;
  checkoutUrl: string | null;
  simulated: boolean;
  /** True when the "open" payment turned out to be paid already. */
  settled?: boolean;
};

/**
 * Opens — or continues — a hosted checkout for one of the caller's own
 * demands. Shared by My Rent and the service-charge statement, which were two
 * copies of the same forty lines and carried the same three faults:
 *
 *   1. they called `getGateway()`, the platform merchant account, so every
 *      organisation's tenants paid through TFML's Paystack (0288);
 *   2. they wrote `checkout_url` through the caller's session, which RLS
 *      declines for a tenant without an error — so "Continue payment" had no
 *      address to continue to and fell back to the simulated checkout: a 404;
 *   3. an open payment was only ever RE-OPENED, never checked — so a tenant
 *      who had paid and come back saw "Continue payment" on a debt they had
 *      settled, and pressing it would have asked them to pay again.
 *
 * The RPC that creates the intent (`create_rent_payment_intent` /
 * `create_service_charge_payment_intent`) still decides standing and the
 * amount; nothing here re-implements either.
 */
export async function openCheckout(opts: {
  supabase: SupabaseClient;
  userEmail: string;
  orgId: string;
  currency: string;
  openReference: string | null;
  createIntent: (gatewayName: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  returnPath: string;
  purpose: "rent" | "service_charge";
}): Promise<ActionResult<CheckoutResult>> {
  const { supabase } = opts;

  // ── An open payment: ask the gateway before anything else ────────────────
  if (opts.openReference) {
    const { data: existing } = await supabase
      .from("payment_intents")
      .select("id, gateway_reference, checkout_url, gateway")
      .eq("gateway_reference", opts.openReference)
      .maybeSingle();

    if (existing) {
      const outcome = await settleIntentByReference(existing.gateway_reference);
      if (outcome.state === "paid" || outcome.state === "already") {
        return ok({ reference: existing.gateway_reference, checkoutUrl: null, simulated: false, settled: true });
      }
      // Could not get an answer. Nothing may be retired or re-opened on a
      // guess: if the tenant HAS paid, a second checkout is how they pay twice.
      if (outcome.state === "unknown") {
        return fail(
          "We could not check this payment with the payment gateway just now.",
          "If you have already paid, you do not need to pay again — it will be recorded as soon as the gateway confirms it. Please try again in a few minutes."
        );
      }
      if (existing.checkout_url) {
        return ok({
          reference: existing.gateway_reference,
          checkoutUrl: existing.checkout_url,
          simulated: existing.gateway === "simulated",
        });
      }
      if (existing.gateway === "simulated") {
        return ok({ reference: existing.gateway_reference, checkoutUrl: null, simulated: true });
      }
      // A live-gateway payment with no address to go back to — opened before
      // 0288, when the address was silently never saved. The gateway has just
      // said it is not paid, so it is retired and a fresh one opened below;
      // leaving it would block a new one forever (one live intent per demand).
      const { error: retireErr } = await supabase.rpc("retire_unopened_payment_intent", {
        p_intent_id: existing.id,
      });
      if (retireErr) return fail(retireErr.message.replace(/^.*?:\s*/, ""));
    }
  }

  // ── This organisation's own merchant account, or nothing ─────────────────
  let resolved;
  try {
    resolved = await resolveOrgGateway(opts.orgId, opts.currency);
  } catch (e) {
    if (e instanceof GatewayNotConnectedError) {
      return fail(
        e.message,
        "Use “Bank transfer / pay another way” on the same demand — it shows this organisation’s own account to pay into."
      );
    }
    return fail(e instanceof Error ? e.message : "The payment could not be opened.");
  }
  const { adapter, merchant } = resolved;

  const { data: intentId, error: rpcError } = await opts.createIntent(adapter.name);
  if (rpcError) return fail(rpcError.message.replace(/^.*?:\s*/, ""));

  const { data: intent } = await supabase
    .from("payment_intents")
    .select("gateway_reference, amount_expected, currency")
    .eq("id", intentId as string)
    .single();
  if (!intent) return fail("The payment could not be opened. Please try again.");

  // Back to THIS organisation's own portal — never the deployment's generic
  // address, and never another brand's (lib/portal-origin.ts).
  const origin = await portalOrigin(opts.orgId, "return");
  const init = await adapter.initialise({
    reference: intent.gateway_reference,
    amount: Number(intent.amount_expected),
    currency: intent.currency,
    email: opts.userEmail,
    callbackUrl: `${origin}${opts.returnPath}?ref=${encodeURIComponent(intent.gateway_reference)}`,
    metadata: { purpose: opts.purpose },
  });
  if (!init.ok) return fail(`The payment gateway rejected the request: ${init.error}`);

  // The one write path (0288). Records the address to continue to AND which
  // merchant account took it — the second decides which key verifies it.
  const { error: setErr } = await supabase.rpc("set_payment_intent_checkout", {
    p_intent_id: intentId,
    p_checkout_url: merchant === "simulated" ? null : init.checkoutUrl ?? null,
    p_merchant_account: merchant === "simulated" ? "platform" : merchant,
  });
  if (setErr) {
    // The checkout is open and this person can still use it now; only a later
    // "Continue payment" would miss the address. Logged, not surfaced.
    console.error("could not record checkout address:", setErr.message);
  }

  return ok({
    reference: intent.gateway_reference,
    checkoutUrl: init.checkoutUrl && !init.checkoutUrl.startsWith("/") ? init.checkoutUrl : null,
    simulated: merchant === "simulated",
  });
}

/**
 * The payer's return from checkout, verified server-to-server. Only for an
 * intent the CALLER can read (`payment_intents_select` admits the payer), so a
 * reference in somebody else's URL settles nothing for them — though settling
 * someone's genuinely-paid payment would harm nobody either.
 */
export async function checkReturnedPayment(
  supabase: SupabaseClient,
  reference: string
): Promise<ActionResult<{ state: "paid" | "pending" | "failed"; amount?: number; currency?: string }>> {
  const { data: mine } = await supabase
    .from("payment_intents")
    .select("id, status, ledger_entry_id, amount_paid, currency")
    .eq("gateway_reference", reference)
    .maybeSingle();
  if (!mine) {
    return fail(
      "That payment could not be found on your account.",
      "Check you are signed in as the person who made it."
    );
  }
  if (mine.ledger_entry_id) {
    return ok({ state: "paid", amount: Number(mine.amount_paid), currency: mine.currency });
  }

  const outcome = await settleIntentByReference(reference);
  if (outcome.state === "paid") return ok({ state: "paid", amount: outcome.amount, currency: outcome.currency });
  if (outcome.state === "already") return ok({ state: "paid" });
  if (outcome.state === "failed") return ok({ state: "failed" });
  if (outcome.state === "unknown") {
    return fail(
      "We could not reach the payment gateway to confirm this yet.",
      "If you completed it, it will be recorded automatically once the gateway confirms it — you do not need to pay again."
    );
  }
  return ok({ state: "pending" });
}
