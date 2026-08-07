"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { averageComposite } from "@/lib/vendor-score";
import { sendCascade } from "@/lib/cascade";
import { formatNaira } from "@/lib/currency";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, REMITTANCE_LIMIT } from "@/lib/rate-limit";

async function loadPayment(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, org_id, vendor_id, amount, status, service_verified_at, performance_validated, approved_at"
    )
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return data;
}

// Stage 1 — Service verification (FM/admin, enforced by RLS update policy).
export async function verifyService(paymentId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("payments")
    .update({
      service_verified_by: user?.id ?? null,
      service_verified_at: new Date().toISOString(),
      status: "verified",
    })
    .eq("id", paymentId)
    .eq("status", "pending_verification");
  if (error) return failFromDb(error, "verify this service");
  revalidatePath(`/dashboard/payments/${paymentId}`);
  return ok();
}

// Stage 2 — Performance validation. Auto-pulls the vendor's composite score and
// compares to the admin-configured threshold. Pass → recommended; fail →
// rejected (blocked). This is the KPI gate.
export async function runPerformanceCheck(paymentId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const payment = await loadPayment(supabase, paymentId);
  if (!payment) return fail("That payment could not be found.");

  if (!payment.service_verified_at) {
    return fail("Service must be verified before the performance check.");
  }

  const { data: settings } = await supabase
    .from("payment_settings")
    .select("min_performance_score")
    .eq("org_id", payment.org_id)
    .single();
  const threshold = Number(settings?.min_performance_score ?? 70);

  // ⚠️ vendor_evaluation_tickets, never the raw vendor_evaluations table
  // (audit 0805-H2). Since 0104, a completed job writes TWO half-populated
  // rows (fm_pm: quality/response/completion/compliance; tenant:
  // satisfaction only) — vendor_evaluations.composite_score is a generated
  // column written for the old one-row-with-everything model, and COALESCEs
  // whichever half a given row doesn't carry to zero. Averaging that raw
  // column here would gate real money on a number that structurally
  // undercounts every dual-source pair: a vendor scored perfectly on both
  // halves would still average out to well under most thresholds. The view
  // populates composite_score ONLY once both halves of a pair exist, at the
  // real AURA weights — averageComposite() already discards the nulls for
  // any job still awaiting its other half, which is exactly right: a pending
  // half must contribute nothing to this gate, not a corrupted number.
  const { data: evals } = await supabase
    .from("vendor_evaluation_tickets")
    .select("composite_score")
    .eq("vendor_id", payment.vendor_id);
  const avg = averageComposite(evals ?? []);

  const passed = avg != null && avg >= threshold;

  const { error } = await supabase
    .from("payments")
    .update({
      performance_validated: passed,
      status: passed ? "recommended" : "rejected",
    })
    .eq("id", paymentId);
  if (error) return failFromDb(error, "record the performance check");
  revalidatePath(`/dashboard/payments/${paymentId}`);
  return ok();
}

// Stage 3 — Approval (finance/admin). Re-checks the gate from the DB so it
// cannot be bypassed: both verification and performance must have passed.
// Enforces the admin-configured approval threshold (B4/B7): payments above the
// limit require an admin, not just a finance approver — making
// `approval_threshold_amount` an enforced control rather than display-only.
export async function approvePayment(paymentId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const payment = await loadPayment(supabase, paymentId);
  if (!payment) return fail("That payment could not be found.");

  if (!payment.service_verified_at) {
    return fail(
      "This payment cannot be approved: the service has not been verified.",
      "Verify the service was delivered first — no payment is released without it."
    );
  }
  if (!payment.performance_validated) {
    return fail(
      "This payment cannot be approved: the vendor failed the performance check.",
      "Review the vendor's scorecard, or raise the concern with an administrator."
    );
  }
  if (payment.status !== "recommended") {
    return fail(`A payment at status '${payment.status}' cannot be approved.`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Threshold gate: above the configured limit, only an admin may approve.
  const { data: approver } = await supabase
    .from("users")
    .select("role")
    .eq("id", user?.id ?? "")
    .single();
  const { data: settings } = await supabase
    .from("payment_settings")
    .select("approval_threshold_amount")
    .eq("org_id", payment.org_id)
    .single();
  const threshold = Number(settings?.approval_threshold_amount ?? 1_000_000);
  if (Number(payment.amount) > threshold && approver?.role !== "admin") {
    return fail(
      `Approvals above ${formatNaira(threshold)} require an administrator — this payment is ${formatNaira(payment.amount)}.`,
      "Ask an administrator to approve it, or have the threshold reviewed in Settings."
    );
  }

  const { error } = await supabase
    .from("payments")
    .update({
      approved_by: user?.id ?? null,
      approved_at: new Date().toISOString(),
      status: "approved",
    })
    .eq("id", paymentId);
  if (error) return failFromDb(error, "approve this payment");

  // Approving IS the moment the obligation arises, so that is when it enters the
  // books (0042). Idempotent, and deliberately not fatal: an approval that has
  // been recorded must not be undone because the ledger posting failed — the
  // remittance path recognises it again before paying anything out.
  {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { error: payableErr } = await supabaseAdmin.rpc("recognise_vendor_payable", {
      p_payment_id: paymentId,
    });
    if (payableErr) {
      console.error("could not recognise vendor payable:", payableErr.message);
    }
  }

  // Notify the vendor of approval via the B8 cascade (best-effort; never blocks
  // the approval itself).
  try {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("contact_phone, contact_email")
      .eq("id", payment.vendor_id)
      .single();
    if (vendor) {
      await sendCascade({
        orgId: payment.org_id,
        entityType: "payment",
        entityId: paymentId,
        message: `Your payment of ${formatNaira(payment.amount)} has been approved and is queued for remittance.`,
        phone: vendor.contact_phone,
        email: vendor.contact_email,
      });
    }
  } catch (e) {
    console.error("Approval notification cascade failed:", e);
  }

  revalidatePath(`/dashboard/payments/${paymentId}`);
  return ok();
}

// Stage 4 — Remittance. Real money.
//
// The order here is the control, and it is worth stating plainly:
//
//   1. authorise         — finance or admin, checked here because the functions
//                          below run under the service role and would otherwise
//                          make the gate optional
//   2. create            — `create_vendor_remittance` re-checks the ENTIRE B4
//                          gate in the database (verified, performance passed,
//                          approved, approved-status, a verified recipient on
//                          file) and recognises the liability. The UI cannot
//                          skip a step by calling this directly.
//   3. claim             — flips queued → sending under a row lock. Two clicks
//                          race here, and the loser is refused, so the gateway
//                          is only ever instructed once.
//   4. send              — the transfer itself
//   5. post              — ONLY on a confirmed success. A `pending` transfer is
//                          left for the webhook; posting it would record money
//                          as having left on a transfer that may still fail.
export type RemittanceResult = ActionResult<{
  status: "sent" | "pending";
  reference: string;
}>;

export async function executeRemittance(paymentId: string): Promise<RemittanceResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return fail("Only finance or an administrator can send a remittance.");
  }

  // Per-caller cap on real transfers. lib/rate-limit.ts fails open by design
  // everywhere else, but this route moves money, so a genuine Redis outage
  // (`degraded`) refuses rather than going unguarded — never configuring
  // Upstash at all (dev, the POC demo) is unaffected and behaves as before.
  const remitGate = await checkRateLimit(
    "remittance-execute", user.id, REMITTANCE_LIMIT.limit, REMITTANCE_LIMIT.window
  );
  if (remitGate.degraded) {
    return fail(
      "The abuse-protection check for remittances is currently unavailable.",
      "Nothing has been sent. Try again shortly, or contact support if this persists."
    );
  }
  if (!remitGate.allowed) {
    return fail(
      "Too many remittances sent in a short window.",
      "Wait a few minutes and try again — this protects against a runaway or compromised session."
    );
  }

  const payment = await loadPayment(supabase, paymentId);
  if (!payment) return fail("That payment could not be found.");

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { getGateway, newPaymentReference } = await import("@/lib/gateway");

  const reference = newPaymentReference("remittance");

  // 2 — the database re-checks the whole gate. Its refusals are written for a
  // person, so they are surfaced as-is.
  const { data: remittanceId, error: createErr } = await supabaseAdmin.rpc(
    "create_vendor_remittance",
    { p_payment_id: paymentId, p_reference: reference }
  );
  if (createErr) {
    return fail(
      createErr.message.replace(/^.*?:\s*/, ""),
      "Nothing has been sent. Resolve the reason above and try again."
    );
  }

  // 3 — claim it. Losing this race is not an error worth alarming anyone about:
  // it means the transfer is already on its way.
  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
    "claim_remittance_for_sending",
    { p_id: remittanceId }
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
      p_id: remittanceId, p_status: "failed",
      p_message: "the payee has no verified gateway recipient",
    });
    return fail(
      "This vendor has no verified bank recipient on file.",
      "Add their bank details on the vendor's page first. Nothing has been sent."
    );
  }

  // 4 — the amount comes from the remittance record, never from the request.
  const gateway = getGateway(row.currency);
  const result = await gateway.transfer({
    reference: row.reference,
    recipientCode: recipient.recipient_code,
    amount: Number(row.net_amount),
    currency: row.currency,
    reason: `Vendor payment ${row.reference} — ${recipient.display_name}`,
  });

  // A transport failure is the dangerous case: the instruction may or may not
  // have arrived. Recorded as `unknown` so a person reconciles it, rather than
  // being guessed either way.
  if (!result.ok && !result.status) {
    await supabaseAdmin.rpc("record_remittance_outcome", {
      p_id: remittanceId, p_status: "unknown", p_message: result.error ?? "gateway unreachable",
    });
    revalidatePath(`/dashboard/payments/${paymentId}`);
    return fail(
      "The gateway could not be reached, and it is not known whether the transfer was accepted.",
      "This has been flagged for reconciliation. Do NOT retry — check the gateway before sending again."
    );
  }

  if (result.status === "failed" || result.status === "otp") {
    await supabaseAdmin.rpc("record_remittance_outcome", {
      p_id: remittanceId,
      p_status: "failed",
      p_message: result.error ?? (result.status === "otp" ? "the account requires an OTP per transfer" : null),
    });
    revalidatePath(`/dashboard/payments/${paymentId}`);
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
    revalidatePath(`/dashboard/payments/${paymentId}`);
    return ok({ status: "pending", reference: row.reference });
  }

  const { error: postErr } = await supabaseAdmin.rpc("record_remittance_sent", {
    p_id: remittanceId,
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

  await supabaseAdmin
    .from("payments")
    .update({ status: "remitted", remittance_reference: row.reference })
    .eq("id", paymentId);

  revalidatePath(`/dashboard/payments/${paymentId}`);
  revalidatePath("/dashboard/ledger");
  return ok({ status: "sent", reference: row.reference });
}
