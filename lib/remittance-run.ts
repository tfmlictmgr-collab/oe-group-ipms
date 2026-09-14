import { revalidatePath } from "next/cache";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// Sending a remittance that has already been created.
//
// Steps 3–5 of the sequence in `app/dashboard/payments/[id]/actions.ts`:
//
//   3. claim  — flips queued → sending under a row lock. Two clicks race here,
//               and the loser is refused, so the gateway is only ever
//               instructed once.
//   4. send   — the transfer itself, for the amount on the remittance record
//               and to the recipient code the gateway already holds. Neither
//               comes from the request.
//   5. post   — ONLY on a confirmed success. A `pending` transfer is left for
//               the webhook; posting it would record money as having left on a
//               transfer that may still fail.
//
// ⚠️ Extracted because the landlord payout run needs exactly these three steps
// and nothing about them is vendor-specific. Steps 1 (authorise) and 2 (create,
// which re-checks the whole gate in the database) stay with each caller,
// because those genuinely differ: a vendor remittance settles one approved
// payment, a landlord remittance settles rent collected over a period.
//
// Writing this twice was the alternative. Two copies of a transfer path is how
// one of them ends up without the `unknown` branch below — the one that stops a
// double send after a timeout — and this file exists so that cannot happen.

export type RemittanceOutcome = ActionResult<{
  status: "sent" | "pending";
  reference: string;
}>;

export async function sendCreatedRemittance(opts: {
  remittanceId: string;
  /**
   * Who is releasing the money. REQUIRED and never defaulted — this call runs
   * through the service-role client, where `auth.uid()` is null by definition,
   * so a defaulted sender would silently reintroduce the exact defect 0142
   * found (`created_by` NULL on every remittance ever written). The gate reads
   * this to check finance authority and that the sender approved no stage.
   */
  sentBy: string;
  /** What the payee sees on their statement. */
  reasonFor: (recipientName: string, reference: string) => string;
  /** Paths to revalidate on every terminal outcome. */
  revalidate: string[];
  /** Run only after a CONFIRMED success has posted to the ledger. */
  onPosted?: (reference: string) => Promise<void>;
}): Promise<RemittanceOutcome> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { getGatewayForOrg } = await import("@/lib/gateway");

  const touch = () => {
    for (const p of opts.revalidate) revalidatePath(p);
  };

  // ⚠️ Which gateway, BEFORE the claim. Since 0288 an organisation with no
  // Paystack account of its own is refused one — correctly — and this used to
  // ask only after claiming, so the refusal was thrown with the remittance
  // already flipped to `sending` and nothing sent: stuck, looking in flight,
  // and needing a person with database access to put it back. Asking first
  // leaves it queued and says what the officer can do instead.
  const { data: pre } = await supabaseAdmin
    .from("remittances")
    .select("org_id, currency, recipient_id")
    .eq("id", opts.remittanceId)
    .maybeSingle();
  if (!pre) return fail("That payment could not be found.");

  // ⚠️ 14 Sept 2026. A Paystack recipient lives on the merchant account it was
  // CREATED on. Before 0288 every organisation without its own key created
  // recipients on the platform (TFML) account — 4 at OEA and 35 at Foundation
  // POC — and a send from the organisation's own account now cannot reach
  // them. Asked before the claim, like the gateway check below, so the payout
  // stays queued with a sentence instead of going to `sending` and failing at
  // Paystack. The owner of the platform key is exempt: those were its own.
  if (pre.recipient_id) {
    const [{ data: rcp }, { data: orgRow }, { data: firstKey }] = await Promise.all([
      supabaseAdmin.from("payout_recipients")
        .select("gateway, created_at, bank_name, account_number_last4")
        .eq("id", pre.recipient_id).maybeSingle(),
      supabaseAdmin.from("orgs").select("uses_platform_gateway").eq("id", pre.org_id).maybeSingle(),
      supabaseAdmin.from("org_gateway_credentials").select("created_at")
        .eq("org_id", pre.org_id).eq("gateway", "paystack")
        .order("created_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    const onSharedAccount =
      rcp && rcp.gateway === "paystack" && !orgRow?.uses_platform_gateway &&
      (!firstKey || new Date(rcp.created_at) < new Date(firstKey.created_at));
    if (onSharedAccount) {
      return fail(
        `The ${rcp!.bank_name ?? "bank"} account ending ${rcp!.account_number_last4 ?? "…"} was registered on the shared platform Paystack account, before this organisation connected its own — a send from this organisation's account cannot reach it.`,
        "Pay by bank transfer instead (their page can use this verified account once a document showing its full number is attached), or register the account again. Nothing has been sent."
      );
    }
  }

  let gateway: Awaited<ReturnType<typeof getGatewayForOrg>>;
  try {
    gateway = await getGatewayForOrg(pre.org_id, pre.currency);
  } catch (e) {
    const { GatewayNotConnectedError } = await import("@/lib/gateway");
    return e instanceof GatewayNotConnectedError
      ? fail(
          "This organisation has not connected its own Paystack account, so this cannot go through Paystack.",
          "Use Record a bank transfer instead: make the transfer from the organisation's bank, then attach the bank's confirmation. Nothing has been sent."
        )
      : fail(e instanceof Error ? e.message : "The payment gateway could not be used.", "Nothing has been sent.");
  }

  // 3 — claim it. Losing this race is not an error worth alarming anyone about:
  // it means the transfer is already on its way.
  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
    "claim_remittance_for_sending",
    { p_id: opts.remittanceId, p_sent_by: opts.sentBy }
  );
  if (claimErr) {
    // ⚠️ Not every refusal here is a lost race any more. Since 0152 this is the
    // gate that checks the approval chain, the finance authority and the
    // separation of duties — and those refusals are written for the person
    // reading them. Flattening all of them into "already being sent" would tell
    // someone their payout was in flight when it had actually been refused for
    // want of an approval, which is a worse lie than an unhelpful error.
    const raw = claimErr.message.replace(/^.*?:\s*/, "");
    const lostTheRace = /already (sending|sent|failed)/i.test(raw);
    return lostTheRace
      ? fail("This remittance is already being sent.", "Refresh in a moment to see the outcome.")
      : fail(raw, "Nothing has been sent.");
  }

  const row = (Array.isArray(claimed) ? claimed[0] : claimed) as {
    org_id: string;
    recipient_id: string;
    net_amount: number | string;
    currency: string;
    reference: string;
  };

  // The payee comes from the remittance's own recipient, not from anything
  // passed in. Money can only go to a code the gateway already holds.
  const { data: recipient } = await supabaseAdmin
    .from("payout_recipients")
    .select("recipient_code, display_name")
    .eq("id", row.recipient_id)
    .single();

  if (!recipient?.recipient_code) {
    await supabaseAdmin.rpc("record_remittance_outcome", {
      p_id: opts.remittanceId, p_status: "failed",
      p_message: "the payee has no verified gateway recipient",
    });
    touch();
    return fail(
      "That payee has no verified bank recipient on file.",
      // ⚠️ Name the PLACE, not just the problem. The payment officer is the one
      // person who can neither approve nor raise anything, so "add their bank
      // details" without saying where is the end of the road for them —
      // whichever screen they are on, the form is not on it. It lives on the
      // contractor's own page.
      "An administrator opens Vendors → that contractor → Payout details and registers the account from their bank letter. Nothing has been sent."
    );
  }

  // 4 — the amount comes from the remittance record, never from the request,
  // and so does the ACCOUNT it is drawn on. A TFML vendor payment must draw on
  // TFML's Paystack balance, never OEA's — before 0156 both drew on whichever
  // account PAYSTACK_SECRET_KEY happened to name, which is segregation failing
  // silently rather than loudly.
  // `gateway` was resolved before the claim, above — for this remittance's own
  // organisation and currency, which is what `row` would have said.
  const result = await gateway.transfer({
    reference: row.reference,
    recipientCode: recipient.recipient_code,
    amount: Number(row.net_amount),
    currency: row.currency,
    reason: opts.reasonFor(recipient.display_name, row.reference),
  });

  // A transport failure is the dangerous case: the instruction may or may not
  // have arrived. Recorded as `unknown` so a person reconciles it, rather than
  // being guessed either way.
  if (!result.ok && !result.status) {
    await supabaseAdmin.rpc("record_remittance_outcome", {
      p_id: opts.remittanceId, p_status: "unknown",
      p_message: result.error ?? "gateway unreachable",
    });
    touch();
    return fail(
      "The gateway could not be reached, and it is not known whether the transfer was accepted.",
      "This has been flagged for reconciliation. Do NOT retry — check the gateway before sending again."
    );
  }

  if (result.status === "failed" || result.status === "otp") {
    await supabaseAdmin.rpc("record_remittance_outcome", {
      p_id: opts.remittanceId,
      p_status: "failed",
      p_message:
        result.error ??
        (result.status === "otp" ? "the account requires an OTP per transfer" : null),
    });
    touch();
    return fail(
      result.status === "otp"
        ? "This gateway account requires a one-time code for every transfer, which the system cannot supply."
        : `The transfer was refused: ${result.error ?? "no reason given"}`,
      result.status === "otp"
        ? "Disable OTP for transfers in the Paystack dashboard, or send this one manually."
        : "No money has left the account."
    );
  }

  // 5 — only a confirmed success posts to the ledger.
  if (result.status !== "success") {
    touch();
    return ok({ status: "pending", reference: row.reference });
  }

  const { error: postErr } = await supabaseAdmin.rpc("record_remittance_sent", {
    p_id: opts.remittanceId,
    p_transfer_code: result.transferCode ?? row.reference,
  });
  if (postErr) {
    // The money HAS left. Never report this as a failure — that would invite a
    // retry, and a second transfer is unrecoverable.
    console.error("remittance posted at the gateway but not in the ledger:", postErr.message);
    return fail(
      "The transfer was sent, but it could not be recorded in the ledger.",
      "Do NOT retry. Give this reference to whoever maintains the books: " + row.reference
    );
  }

  if (opts.onPosted) await opts.onPosted(row.reference);

  touch();
  return ok({ status: "sent", reference: row.reference });
}
