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
  const { data: { user } } = await supabase.auth.getUser();
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

  // ⚠️ A failing check now states WHY, in the vendor's terms and with the two
  // numbers in it. `enforce_payment_transition` refuses a rejection without a
  // reason since 0136, and this is the only automated rejection in the system —
  // it used to produce the silent dead end the whole of 0136 exists to close.
  const reason = passed
    ? null
    : avg == null
      ? `No completed evaluation is on record for this vendor yet, so the performance gate (minimum ${threshold}) cannot be cleared. It will pass once a job of theirs has been scored by both the FM/PM and the tenant.`
      : `Performance score ${avg.toFixed(1)} is below this organisation's minimum of ${threshold}.`;

  const { error } = await supabase
    .from("payments")
    .update({
      performance_validated: passed,
      status: passed ? "recommended" : "rejected",
      ...(passed ? {} : { rejected_reason: reason, rejected_by: user?.id ?? null, rejected_at: new Date().toISOString() }),
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

  // Threshold gate — ASKED FOR, not re-derived.
  //
  // ⚠️ This block used to compute the rule itself: `threshold` from
  // payment_settings, and `approver?.role !== "admin"`. That is a second copy
  // of what `enforce_payment_transition` already enforces, and the two had
  // drifted. The board added the executive on 29 July 2026 — the MD of TFML
  // and the Managing Partner of OEA co-hold approval "including above the
  // threshold" (decision 9) — 0073 put that in the trigger, and this line was
  // never updated. So an MD was told to "ask an administrator" for a payment
  // the database would have accepted from them; verified against the live
  // trigger before changing it.
  //
  // `my_approval_limit()` (0127) now answers instead, from the same role list
  // the trigger uses. The check stays here rather than being deleted entirely
  // because the trigger's refusal reaches the user as an opaque database
  // error, and "this needs an administrator or an executive" is worth saying
  // in the user's own words before that happens. The trigger remains the
  // enforcement; this is only the courtesy.
  const { data: limitRows } = await supabase.rpc("my_approval_limit");
  const limit = (limitRows ?? [])[0] as
    | { threshold: number | string; unlimited: boolean; may_approve: boolean }
    | undefined;

  if (limit && !limit.may_approve) {
    return fail("Only finance, an administrator or an executive may approve payments.");
  }
  if (limit && !limit.unlimited && Number(payment.amount) > Number(limit.threshold)) {
    return fail(
      `Approvals above ${formatNaira(limit.threshold)} require an administrator or an executive — this payment is ${formatNaira(payment.amount)}.`,
      "Ask an administrator or the MD to approve it, or have the threshold reviewed in Settings."
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
      // `user_id` so the consent gate (0148) can resolve the PERSON behind the
      // vendor record. A vendor with no portal account has no consent on file
      // and no way to give it, so WhatsApp is skipped for them and the cascade
      // falls through to email — which is the correct outcome, not a bug.
      .select("contact_phone, contact_email, user_id")
      .eq("id", payment.vendor_id)
      .single();
    if (vendor) {
      await sendCascade({
        orgId: payment.org_id,
        entityType: "payment",
        entityId: paymentId,
        recipientUserId: vendor.user_id,
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

  // Finance disburses — an administrator approves within their threshold and
  // an executive above it, and neither releases the funds (0142). Said in
  // plain words here; the database refuses it regardless, and the maker-checker
  // rule below is enforced only there because it must hold for every call site.
  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || me.role !== "finance_approver") {
    return fail(
      "Only a finance approver can send a payment.",
      "Oversight authorises; finance disburses — approving against a limit you can lift yourself is not an approval."
    );
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
  const { newPaymentReference } = await import("@/lib/gateway");

  const reference = newPaymentReference("remittance");

  // 2 — the database re-checks the whole gate. Its refusals are written for a
  // person, so they are surfaced as-is.
  // ⚠️ The executor is PASSED, not inferred. This call goes through the
  // service-role client (the functions below need rights the caller has not
  // got), which means `auth.uid()` inside the function is null — so the
  // function used to stamp `created_by` NULL and no row anywhere recorded who
  // released the money. The id comes from `getUser()` above, which verified
  // the session; the function re-checks that this person may disburse and is
  // not the approver.
  const { data: remittanceId, error: createErr } = await supabaseAdmin.rpc(
    "create_vendor_remittance",
    { p_payment_id: paymentId, p_reference: reference, p_executed_by: user.id }
  );
  if (createErr) {
    return fail(
      createErr.message.replace(/^.*?:\s*/, ""),
      "Nothing has been sent. Resolve the reason above and try again."
    );
  }

  // 3–5 — claim, send, post. Shared with the landlord payout run
  // (`lib/remittance-run.ts`): nothing in those three steps is
  // vendor-specific, and two copies of a transfer path is how one of them
  // ends up without the `unknown` branch that stops a double send.
  const { sendCreatedRemittance } = await import("@/lib/remittance-run");
  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    sentBy: user.id,
    reasonFor: (name, ref) => `Vendor payment ${ref} — ${name}`,
    revalidate: [`/dashboard/payments/${paymentId}`, "/dashboard/ledger"],
    // Only after the ledger has the posting. The payment is what this
    // remittance settles, so it is marked here rather than inside the shared
    // helper, which knows nothing about payments.
    onPosted: async (reference) => {
      await supabaseAdmin
        .from("payments")
        .update({ status: "remitted", remittance_reference: reference })
        .eq("id", paymentId);
    },
  });
}

// ── Refusing an invoice, and undoing a refusal ────────────────────────────
//
// Both go through database functions rather than a direct UPDATE, because both
// carry a REASON that must exist and a notification the vendor depends on.
// `enforce_payment_transition` refuses a reasonless rejection since 0136, so
// there is no way to produce the silent dead end these replace.

export async function rejectPayment(
  paymentId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_payment", {
    p_id: paymentId,
    p_reason: reason,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath(`/dashboard/payments/${paymentId}`);
  revalidatePath("/dashboard/payments");
  return ok();
}

/**
 * The appeal outcome: a rejection that should not have happened.
 *
 * Finance or an administrator only — enforced in the trigger, not here,
 * because reopening corrects a refusal the FM's own performance gate may have
 * produced. The invoice returns to the START of the gate with verification and
 * performance cleared, so nothing is inherited from before the refusal.
 */
export async function reopenPayment(
  paymentId: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reopen_payment", {
    p_id: paymentId,
    p_reason: reason,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath(`/dashboard/payments/${paymentId}`);
  revalidatePath("/dashboard/payments");
  return ok();
}
