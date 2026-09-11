"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { cascadeToUserIds, notifyRoleWithCascade } from "@/lib/role-notify";
import { sendEmail, type MailContext } from "@/lib/email";
import { formatMoney } from "@/lib/currency";
import {
  CONFIRMATION_STAGES, type AllocationInput, type OfflineMethod,
} from "@/lib/offline-payments";

// Recording and confirming a payment made off-platform.
//
// Expected failures are RETURNED, not thrown — `raisePaymentRequest`'s own note
// applies unchanged: Next replaces the message of any error thrown in a Server
// Action with an opaque digest in production, so every sentence the database
// carefully writes ("that demand is billed to somebody else", "you recorded this
// payment, so you cannot also confirm it") would reach the user as "an error
// occurred". Anything a person can act on is part of the return type.
//
// ⚠️ Nothing here re-implements a rule. Standing, the compulsory proof, the
// breakdown reconciliation, the chain order, the maker-checker and the ledger
// posting are all in 0281/0282, because this file is not the only caller and a
// rule that lives in a server action is a rule the next caller skips.

/** Strips the `ERROR:  ` / context prefixes Postgres puts on a raise. */
const plain = (m: string) => m.replace(/^.*?:\s*/, "").trim();

export type RecordInput = {
  method: OfflineMethod;
  amount: number;
  paidOn: string;
  bankAccountId: string;
  proofPath: string;
  proofFilename?: string | null;
  allocations: AllocationInput[];
  currency?: string;
  payerReference?: string | null;
  payerNote?: string | null;
  /** Where the money came from (0286). Bank, resolved name, last four only. */
  payerBankName?: string | null;
  payerAccountName?: string | null;
  payerAccountLast4?: string | null;
};

export async function recordOfflinePayment(
  input: RecordInput
): Promise<ActionResult<{ claimId: string; reference: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: claimId, error } = await supabase.rpc("submit_offline_payment_claim", {
    p_method: input.method,
    p_amount: input.amount,
    p_paid_on: input.paidOn,
    p_bank_account_id: input.bankAccountId,
    p_proof_path: input.proofPath,
    p_allocations: input.allocations,
    p_currency: input.currency ?? "NGN",
    p_payer_reference: input.payerReference ?? null,
    p_payer_note: input.payerNote ?? null,
    p_proof_filename: input.proofFilename ?? null,
    p_payer_bank_name: input.payerBankName ?? null,
    p_payer_account_name: input.payerAccountName ?? null,
    p_payer_account_last4: input.payerAccountLast4 ?? null,
  });
  if (error) return failFromDb(error, "record this payment");

  const { data: claim } = await supabase
    .from("offline_payment_claims")
    .select("reference, claimed_amount, currency, org_id")
    .eq("id", claimId)
    .single();

  // The auditor is stage 1, so they are who is waiting. Best-effort and
  // swallowed: the claim exists and is on the queue either way, and a mail
  // provider being down must not turn a recorded payment into a failed one.
  try {
    await notifyRoleWithCascade({
      orgId: claim!.org_id,
      roles: ["payment_audit_approver"],
      kind: "payment",
      title: "A payment was reported as paid off-platform",
      body: `${claim!.reference} — ${formatMoney(Number(claim!.claimed_amount), claim!.currency)} awaiting audit verification.`,
      link: `/dashboard/payments/offline/${claimId}`,
      entityType: "payment",
      entityId: null,
    });
  } catch { /* the claim is recorded; the nudge is not the record */ }

  revalidatePath("/dashboard/payments/offline");
  revalidatePath("/dashboard/my-rent");
  revalidatePath("/dashboard/sc");
  return ok({ claimId: claimId as string, reference: claim?.reference ?? "" });
}

export type ConfirmInput = {
  claimId: string;
  stage: number;
  decision: "confirmed" | "returned" | "rejected";
  reason?: string | null;
  statementLineId?: string | null;
};

export async function actionOfflineStage(
  input: ConfirmInput
): Promise<ActionResult<{ posted: boolean }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase.rpc("confirm_offline_payment", {
    p_claim_id: input.claimId,
    p_stage: input.stage,
    p_decision: input.decision,
    p_reason: input.reason ?? null,
    p_statement_line_id: input.statementLineId ?? null,
  });
  if (error) return fail(plain(error.message));

  // Read back what the database now holds rather than assuming the outcome —
  // the same rule the receipt follows (0253): what is stated and what is
  // recorded must be the same numbers by construction.
  const { data: claim } = await supabaseAdmin
    .from("offline_payment_claims")
    .select("id, org_id, reference, status, posted_at, claimed_amount, confirmed_amount, currency, payer_user_id, payer_email, recorded_by, decision_reason")
    .eq("id", input.claimId)
    .single();

  const posted = !!claim?.posted_at;
  await tellThePayer(claim, input, posted);

  // Whoever is waiting NOW.
  if (claim && claim.status === "submitted" && !posted) {
    const next = CONFIRMATION_STAGES.find((s) => s.order === input.stage + 1)
      ?? CONFIRMATION_STAGES.find((s) => s.order === input.stage - 1);
    const waitingRole = input.decision === "returned"
      ? CONFIRMATION_STAGES.find((s) => s.order === input.stage - 1)?.role
      : next?.role;
    if (waitingRole) {
      try {
        await notifyRoleWithCascade({
          orgId: claim.org_id,
          roles: [waitingRole],
          kind: "payment",
          title: input.decision === "returned"
            ? "A reported payment has been sent back to your desk"
            : "A reported payment is waiting for you",
          body: `${claim.reference} — ${formatMoney(Number(claim.claimed_amount), claim.currency)}.`,
          link: `/dashboard/payments/offline/${claim.id}`,
          entityType: "payment",
          entityId: null,
        });
      } catch { /* the queue still shows it */ }
    }
  }

  revalidatePath("/dashboard/payments/offline");
  revalidatePath(`/dashboard/payments/offline/${input.claimId}`);
  revalidatePath("/dashboard/ledger/collections");
  return ok({ posted });
}

/**
 * The payer is told at every decision, not only the last one.
 *
 * ⚠️ A confirmation is the one that matters and it is NOT a receipt — the
 * receipt is generated from the ledger at `/api/receipts/[intentId]` (0253) and
 * is linked from here. A rejection carries the reviewer's own words, because
 * decision 10's basis is that a recorded reason is contestable and a person
 * cannot contest a decision nobody told them about (decision 36, same finding
 * one process over).
 */
async function tellThePayer(
  claim: { id: string; org_id: string; reference: string; status: string;
           claimed_amount: number | string; confirmed_amount: number | string | null;
           currency: string; payer_user_id: string | null; payer_email: string | null;
           recorded_by: string; decision_reason: string | null } | null,
  input: ConfirmInput,
  posted: boolean
) {
  if (!claim) return;
  const money = (n: number | string | null) =>
    formatMoney(Number(n ?? 0), claim.currency);

  const audience = [claim.payer_user_id, claim.recorded_by].filter(Boolean) as string[];
  const unique = Array.from(new Set(audience));

  let title: string | null = null;
  let body = "";

  if (posted) {
    title = "Your payment has been confirmed";
    body = `${claim.reference} — ${money(claim.confirmed_amount)} has been applied to your account.`;
  } else if (claim.status === "rejected") {
    title = "Your reported payment was not accepted";
    body = `${claim.reference} — ${claim.decision_reason ?? "See the payment for details."}`;
  } else if (claim.status === "returned_for_correction") {
    title = "Your reported payment needs something corrected";
    body = `${claim.reference} — ${claim.decision_reason ?? "See the payment for details."}`;
  }
  if (!title) return;

  try {
    for (const uid of unique) {
      // ⚠️ `notify_user` takes no org id (it derives it), and `kind` is a
      // CHECK-constrained set — "payment" is the one that fits. A made-up kind
      // fails the insert, and a notification nobody sees is worse than none.
      await supabaseAdmin.rpc("notify_user", {
        p_user_id: uid,
        p_kind: "payment",
        p_title: title, p_body: body,
        p_link: `/dashboard/payments/offline/${claim.id}`,
        p_entity_type: "offline_payment", p_entity_id: claim.id,
      });
    }
    await cascadeToUserIds(claim.org_id, unique, `${title} — ${body}`, "payment", null);
  } catch { /* the screen still says it */ }

  // ⚠️ And an email, because the payer may hold no portal account at all — a
  // walk-in recorded by staff has an address and nothing else. 0253's finding.
  const to = claim.payer_email;
  if (!to) return;
  try {
    await sendEmail({
      to,
      orgId: claim.org_id,
      category: "finance",
      entityType: "payment",
      entityId: null,
      subject: (ctx: MailContext) => `${ctx.brandName} — ${title!.toLowerCase()}`,
      text: (ctx: MailContext) => [
        `Dear Sir/Madam,`,
        ``,
        body,
        ``,
        posted
          ? `A receipt has been issued from our ledger and is available in your portal.`
          : `Reference: ${claim.reference}`,
        ...(claim.status === "returned_for_correction"
          ? [``, `You can correct and re-send it from your portal — nothing further is needed until then.`]
          : []),
        ...(claim.status === "rejected"
          ? [``,
             `If you believe this is wrong, reply to this email with the payment reference and we will look again.`]
          : []),
        ``,
        `${ctx.brandName}`,
      ].join("\n"),
    });
  } catch { /* posted already; mail is not the record */ }
}

export type CorrectInput = {
  claimId: string;
  amount: number;
  allocations: AllocationInput[];
  paidOn?: string | null;
  payerReference?: string | null;
  payerNote?: string | null;
  proofPath?: string | null;
  proofFilename?: string | null;
};

export async function correctOfflinePayment(
  input: CorrectInput
): Promise<ActionResult<{ claimId: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase.rpc("correct_offline_payment_claim", {
    p_claim_id: input.claimId,
    p_amount: input.amount,
    p_allocations: input.allocations,
    p_paid_on: input.paidOn ?? null,
    p_payer_reference: input.payerReference ?? null,
    p_payer_note: input.payerNote ?? null,
    p_proof_path: input.proofPath ?? null,
    p_proof_filename: input.proofFilename ?? null,
  });
  if (error) return fail(plain(error.message));

  const { data: claim } = await supabaseAdmin
    .from("offline_payment_claims")
    .select("org_id, reference, claimed_amount, currency")
    .eq("id", input.claimId).single();

  if (claim) {
    try {
      await notifyRoleWithCascade({
        orgId: claim.org_id,
        roles: ["payment_audit_approver"],
        kind: "payment",
        title: "A returned payment has been corrected and re-sent",
        body: `${claim.reference} — ${formatMoney(Number(claim.claimed_amount), claim.currency)}.`,
        link: `/dashboard/payments/offline/${input.claimId}`,
        entityType: "payment",
        entityId: null,
      });
    } catch { /* it is on the queue regardless */ }
  }

  revalidatePath("/dashboard/payments/offline");
  revalidatePath(`/dashboard/payments/offline/${input.claimId}`);
  return ok({ claimId: input.claimId });
}

/**
 * A short-lived link to the proof, minted under the CALLER's own session.
 *
 * The storage policy (0281) decides: readable by whoever can read the claim. So
 * this grants nothing — it is the same refusal or the same file the caller would
 * get themselves, and it exists only because a private object needs signing.
 */
export async function signProof(objectPath: string): Promise<ActionResult<{ url: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data, error } = await supabase.storage
    .from("payment-proofs")
    .createSignedUrl(objectPath, 300);
  if (error || !data?.signedUrl) {
    return fail(
      "That payment proof could not be opened.",
      "It may have been removed, or you may not have access to this payment."
    );
  }
  return ok({ url: data.signedUrl });
}
