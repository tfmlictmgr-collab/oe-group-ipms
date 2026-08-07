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
  /** What the payee sees on their statement. */
  reasonFor: (recipientName: string, reference: string) => string;
  /** Paths to revalidate on every terminal outcome. */
  revalidate: string[];
  /** Run only after a CONFIRMED success has posted to the ledger. */
  onPosted?: (reference: string) => Promise<void>;
}): Promise<RemittanceOutcome> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { getGateway } = await import("@/lib/gateway");

  const touch = () => {
    for (const p of opts.revalidate) revalidatePath(p);
  };

  // 3 — claim it. Losing this race is not an error worth alarming anyone about:
  // it means the transfer is already on its way.
  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
    "claim_remittance_for_sending",
    { p_id: opts.remittanceId }
  );
  if (claimErr) {
    return fail(
      "This remittance is already being sent.",
      "Refresh in a moment to see the outcome."
    );
  }

  const row = (Array.isArray(claimed) ? claimed[0] : claimed) as {
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
      "Add their bank details first. Nothing has been sent."
    );
  }

  // 4 — the amount comes from the remittance record, never from the request.
  const gateway = getGateway(row.currency);
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
