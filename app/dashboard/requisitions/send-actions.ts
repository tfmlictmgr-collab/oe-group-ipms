"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, failFromDb, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, REMITTANCE_LIMIT } from "@/lib/rate-limit";
import type { RemittanceOutcome } from "@/lib/remittance-run";

type Guard = { ok: true; userId: string; orgId: string } | RemittanceOutcome;

// Disbursing a cleared requisition, per payee — one call settles every
// not-yet-remitted line naming that vendor or that verified one-off payee
// (create_requisition_vendor_remittance / create_requisition_payee_remittance,
// 0173), then the same claim → transfer → post pipeline every other outbound
// payment in this codebase already goes through (lib/remittance-run.ts).

async function guard(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role, org_id").eq("id", user.id).single();
  if (!me || me.role !== "finance_approver") {
    return fail(
      "Only the payment officer can send a payment.",
      "Oversight authorises; finance disburses."
    );
  }

  const gate = await checkRateLimit(
    "remittance-execute", user.id, REMITTANCE_LIMIT.limit, REMITTANCE_LIMIT.window
  );
  if (gate.degraded) {
    return fail(
      "The abuse-protection check for payments is currently unavailable.",
      "Nothing has been sent. Try again shortly."
    );
  }
  if (!gate.allowed) {
    return fail(
      "Too many payments sent in a short window.",
      "Wait a few minutes and try again — this protects against a runaway or compromised session."
    );
  }
  return { ok: true, userId: user.id, orgId: me.org_id };
}

/**
 * A reference carrying this org's tag (0156).
 *
 * ⚠️ Belt AND braces. 0174 made the webhook resolve the org from
 * `remittances.reference` directly, so an untagged reference is no longer fatal
 * — but a reference minted without the tag was what broke every requisition
 * payout's webhook in the first place, and the tag costs one indexed read. The
 * tag is read from the ORG RECORD, never accepted from a caller: a
 * caller-supplied tag would choose which merchant account a payment is
 * attributed to.
 */
async function taggedReference(orgId: string): Promise<string> {
  const supabase = await createClient();
  const { newPaymentReference } = await import("@/lib/gateway");
  const { data: org } = await supabase
    .from("orgs").select("gateway_tag").eq("id", orgId).maybeSingle();
  return newPaymentReference("requisition", org?.gateway_tag ?? null);
}

export async function sendRequisitionVendorLines(
  requisitionId: string,
  vendorId: string
): Promise<RemittanceOutcome> {
  const g = await guard();
  if (!("userId" in g)) return g;

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const reference = await taggedReference(g.orgId);

  const { data: remittanceId, error } = await supabaseAdmin.rpc(
    "create_requisition_vendor_remittance",
    { p_requisition_id: requisitionId, p_vendor_id: vendorId, p_reference: reference, p_executed_by: g.userId }
  );
  if (error) {
    // The same refusal the vendor-invoice path raises, from the requisition
    // side — a contractor on a requisition line is no more payable than one on
    // an invoice until an administrator has registered where they get paid.
    const raw = error.message.replace(/^.*?:\s*/, "");
    const { payoutRefusal } = await import("@/lib/payout-account");
    const { data: v } = await supabaseAdmin
      .from("vendors").select("name").eq("id", vendorId).maybeSingle();
    return (
      payoutRefusal(raw, v?.name ?? "That contractor") ??
      fail(raw, "Nothing has been sent.")
    );
  }

  const { sendCreatedRemittance } = await import("@/lib/remittance-run");
  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    sentBy: g.userId,
    reasonFor: (name, ref) => `Requisition ${ref} — ${name}`,
    revalidate: [`/dashboard/approvals/requisitions/${requisitionId}`, "/dashboard/approvals", "/dashboard/ledger"],
  });
}

export async function sendRequisitionPayeeLines(
  requisitionId: string,
  payeeRecipientId: string
): Promise<RemittanceOutcome> {
  const g = await guard();
  if (!("userId" in g)) return g;

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const reference = await taggedReference(g.orgId);

  const { data: remittanceId, error } = await supabaseAdmin.rpc(
    "create_requisition_payee_remittance",
    { p_requisition_id: requisitionId, p_payee_recipient_id: payeeRecipientId, p_reference: reference, p_executed_by: g.userId }
  );
  if (error) {
    return fail(error.message.replace(/^.*?:\s*/, ""), "Nothing has been sent.");
  }

  const { sendCreatedRemittance } = await import("@/lib/remittance-run");
  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    sentBy: g.userId,
    reasonFor: (name, ref) => `Requisition ${ref} — ${name}`,
    revalidate: [`/dashboard/approvals/requisitions/${requisitionId}`, "/dashboard/approvals", "/dashboard/ledger"],
  });
}


/**
 * Authorise ONE payment a property's service-charge fund cannot cover (0272).
 *
 * ⚠️ Board decision, 7 Sept 2026, and it is an exception to decisions 2 and 27
 * rather than an ordinary feature. The alternative offered — a recorded
 * inter-property transfer, visible on both properties' statements — was
 * declined in favour of this. So it exists, and it is attributable: only the
 * payment officer, a stated reason, an audit row, and single use.
 *
 * The authority check is `authorise_fund_override` under the caller's own
 * session, never the service-role client — `auth.uid()` is the whole basis of
 * "only the payment officer", and 0142 recorded what happens when a money path
 * runs as service-role: the actor is null by definition and the control
 * silently does nothing.
 */
export async function authoriseShortFund(
  payableType: "vendor_payment" | "ops_requisition",
  payableId: string,
  reason: string
): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 20) {
    return fail(
      "Say where the money is coming from, in at least 20 characters.",
      "This is read by whoever asks why one property's fund paid another's bill."
    );
  }

  const supabase = await createClient();
  const { data: state, error: stateErr } = await supabase.rpc("payable_fund_override_state", {
    p_payable_type: payableType,
    p_payable_id: payableId,
  });
  if (stateErr) return failFromDb(stateErr, "check this payment's fund");

  const accountId = (state as { account_id: string | null }[] | null)?.[0]?.account_id ?? null;
  if (!accountId) {
    return fail(
      "This payment has no property fund to authorise against.",
      "Attach it to a property with a service request first — an unattached payment draws on the organisation-wide fund."
    );
  }

  const { error } = await supabase.rpc("authorise_fund_override", {
    p_account_id: accountId,
    p_reason: trimmed,
  });
  if (error) return failFromDb(error, "authorise this payment");

  revalidatePath(`/dashboard/approvals/requisitions/${payableId}`);
  revalidatePath(`/dashboard/payments/${payableId}`);
  revalidatePath("/dashboard/approvals");
  return ok();
}
