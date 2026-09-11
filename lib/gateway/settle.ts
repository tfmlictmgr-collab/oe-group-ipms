import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail, type MailContext } from "@/lib/email";
import { adapterForIntent, type PaymentGatewayAdapter } from "./index";

// Settling a collection from the gateway's own account of it.
//
// ⚠️ ONE implementation, two doors (11 Sept 2026). Until today the only door
// was the gateway's webhook — and on staging not one real Paystack webhook had
// ever been received (`gateway_events` held only the suites' simulated ones),
// so a tenant who paid sat at "pending" indefinitely with nothing anywhere
// able to change it. Paystack's own guidance is to verify on the return from
// checkout AS WELL as on the webhook; the second door is the payer coming back
// to their own statement.
//
// Both doors run exactly this, so they cannot disagree:
//   1. the intent is resolved by OUR reference, from OUR record;
//   2. the gateway is asked server-to-server, on the merchant account the
//      payment was TAKEN on (`adapterForIntent`) — the only trustworthy source
//      of whether and how much was paid; nothing the browser or the webhook
//      body says is believed;
//   3. `record_collection` posts it, idempotently — it locks the intent and
//      returns the existing entry if the other door got there first;
//   4. the receipt is claimed with `receipt_sent_at` before it is sent, so two
//      doors arriving together send one email.
//
// Nobody approves an online payment, and that is deliberate: the gateway
// holding the money and saying so, checked by us server-to-server, IS the
// evidence. Human confirmation belongs to the off-platform route (0281/0282),
// where the only evidence is a photograph a person could have edited.

export type SettleOutcome =
  | { state: "paid"; entryId: string; amount: number; currency: string }
  | { state: "already"; entryId: string }
  | { state: "pending"; detail: string }
  | { state: "failed"; detail: string }
  | { state: "unknown"; detail: string };

export async function settleIntentByReference(
  reference: string,
  opts: { adapter?: PaymentGatewayAdapter } = {}
): Promise<SettleOutcome> {
  const { data: intent } = await supabaseAdmin
    .from("payment_intents")
    .select("id, org_id, gateway, currency, merchant_account, amount_expected, ledger_entry_id, status")
    .eq("gateway_reference", reference)
    .maybeSingle();
  if (!intent) return { state: "unknown", detail: "no matching payment intent" };
  if (intent.ledger_entry_id) return { state: "already", entryId: intent.ledger_entry_id };

  let adapter = opts.adapter;
  try {
    adapter ??= await adapterForIntent(intent);
  } catch (e) {
    return { state: "unknown", detail: e instanceof Error ? e.message : "no adapter" };
  }

  const verified = await adapter.verifyTransaction(reference);
  // ⚠️ "We could not ASK" is not "the gateway said no". A rejected key, a
  // timeout or an outage comes back `ok: false`, and a caller that treated it
  // as "not paid" could retire a payment the tenant has in fact made
  // (`openCheckout` retires an unopenable intent on a definite no). So it is
  // reported as `unknown`, which nothing acts on.
  if (!verified.ok) {
    return { state: "unknown", detail: `the gateway could not be asked: ${verified.error ?? "no answer"}` };
  }
  if (verified.status !== "success") {
    // Only a DEFINITE failure changes the row. "Not yet", or the gateway being
    // unreachable, leaves it pending — a transient network error must never
    // mark a payment someone has made as failed.
    if (verified.ok && verified.status === "failed" && intent.status === "pending") {
      await supabaseAdmin.from("payment_intents").update({ status: "failed" }).eq("id", intent.id);
      return { state: "failed", detail: "the gateway reports this payment failed" };
    }
    return { state: "pending", detail: verified.error ?? verified.status ?? "not confirmed yet" };
  }

  // The amount comes from the gateway's own lookup — never a payload.
  const amount = verified.amount ?? Number(intent.amount_expected);
  const { data: entryId, error } = await supabaseAdmin.rpc("record_collection", {
    p_intent_id: intent.id,
    p_amount_verified: amount,
    p_paid_at: verified.paidAt ?? new Date().toISOString(),
  });
  if (error || !entryId) {
    return { state: "unknown", detail: `posting failed: ${error?.message ?? "no entry"}` };
  }

  // ⚠️ After the posting, and every failure swallowed: the money is recorded;
  // a mail provider being down must never turn a settled collection into an
  // error the caller (or the gateway, retrying a webhook) acts on.
  try {
    await sendCollectionReceiptOnce(intent.id);
  } catch (e) {
    console.error("receipt email failed:", e instanceof Error ? e.message : e);
  }

  return { state: "paid", entryId: entryId as string, amount, currency: intent.currency };
}

/**
 * Emails the payer a receipt — once, whichever door settled the payment.
 *
 * The figures are re-read from the intent AFTER `record_collection` rather
 * than passed in, so what the receipt states and what the ledger holds are the
 * same numbers by construction. Sent through `sendEmail` with the intent's own
 * org, so it leaves from that organisation's sender or not at all (B1).
 */
export async function sendCollectionReceiptOnce(intentId: string): Promise<void> {
  // The claim. Conditional on NULL, so of two doors arriving together exactly
  // one gets a row back.
  const { data: claimed } = await supabaseAdmin
    .from("payment_intents")
    .update({ receipt_sent_at: new Date().toISOString() })
    .eq("id", intentId)
    .is("receipt_sent_at", null)
    .not("ledger_entry_id", "is", null)
    .select("id");
  if (!claimed || claimed.length === 0) return;

  const { data } = await supabaseAdmin
    .from("payment_intents")
    .select(
      "id, org_id, purpose, currency, amount_paid, amount_expected, paid_at, gateway_reference, payer_email, payer_user_id, users:payer_user_id(full_name, email)"
    )
    .eq("id", intentId)
    .maybeSingle();
  if (!data) return;

  const payer = data.users as { full_name?: string; email?: string } | null;
  const to = (data.payer_email as string | null) ?? payer?.email ?? null;
  if (!to) return;

  const paid = Number(data.amount_paid ?? 0);
  const expected = Number(data.amount_expected ?? 0);
  const currency = (data.currency as string) ?? "NGN";
  const money = (n: number) =>
    `${currency === "NGN" ? "₦" : `${currency} `}${n.toLocaleString("en-NG", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}`;
  const what = String(data.purpose ?? "payment").replace(/_/g, " ");

  const res = await sendEmail({
    to,
    orgId: data.org_id as string,
    category: "finance",
    entityType: "payment_intent",
    entityId: data.id as string,
    subject: (ctx: MailContext) => `${ctx.brandName} — receipt for your ${what} payment`,
    text: (ctx: MailContext) =>
      [
        `Dear ${payer?.full_name ?? "Sir/Madam"},`,
        ``,
        `We have received your ${what} payment. Thank you.`,
        ``,
        `Amount received: ${money(paid)}`,
        // Stated only when it differs — on a part payment it is the single
        // most useful line on the page.
        ...(paid < expected
          ? [`Invoiced:        ${money(expected)}`, `Still outstanding: ${money(expected - paid)}`]
          : []),
        `Reference:       ${data.gateway_reference ?? "—"}`,
        `Date:            ${new Date(String(data.paid_at ?? Date.now())).toLocaleDateString("en-NG", {
          day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos",
        })}`,
        ``,
        `This receipt is issued from our ledger, so it always states what has actually been recorded against your account.`,
        ...(data.payer_user_id
          ? [``, `You can see your full payment history any time by signing in to your ${ctx.brandName} portal.`]
          : []),
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
  });

  // Not sent (no sender configured for this org, provider down): release the
  // claim so a later door can try again, rather than recording a receipt that
  // never left.
  if (!res.sent) {
    await supabaseAdmin.from("payment_intents").update({ receipt_sent_at: null }).eq("id", intentId);
  }
}
