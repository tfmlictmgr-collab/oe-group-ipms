"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, REMITTANCE_LIMIT } from "@/lib/rate-limit";
import { namesAgree, type PayoutAccountView } from "@/lib/payout-views";

// Paying somebody by bank transfer (0289) — the staff side.
//
// The database is the control for every act here: `request_payout_details`,
// `adopt_registration_bank_details` and `confirm_payout_account_evidence` run
// under the caller's own session and check their role themselves, and
// `pay_by_bank_transfer` re-runs the whole B4 gate. These actions add the words
// a person reads, the messages that go out, and the rate limit on money.

export type PayoutParty = "vendor" | "landlord" | "other";
export type BankTransferPayable =
  | "vendor_payment"
  | "requisition_vendor"
  | "requisition_payee"
  | "landlord_payout";

type Me = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  id: string;
  org_id: string;
  role: string;
};

async function signedIn(): Promise<Me | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("users").select("id, org_id, role").eq("id", user.id).maybeSingle();
  return data ? { supabase, id: data.id, org_id: data.org_id, role: data.role } : null;
}

const SESSION_EXPIRED = "Your session expired. Please sign in again.";

function touch(paths: (string | undefined)[]) {
  for (const p of ["/dashboard/ledger/payouts", "/dashboard/approvals", ...paths]) {
    if (p) revalidatePath(p);
  }
}

/** "ERROR: something went wrong" → "something went wrong", with a capital. */
function said(message: string): string {
  const s = message.replace(/^.*?ERROR:\s*/i, "").replace(/^[a-z_]+:\s*/i, "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : "That could not be done.";
}

// ── Asking for details ──────────────────────────────────────────────────────

export async function requestPayoutDetails(input: {
  party: PayoutParty;
  vendorId?: string | null;
  userId?: string | null;
  lineId?: string | null;
  payeeName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  purpose?: string | null;
  path?: string;
}): Promise<ActionResult<{ requestId: string; link: string; sentTo: string[] }>> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);

  const { newPayoutToken, hashPayoutToken } = await import("@/lib/payout-evidence");
  const token = newPayoutToken();

  const { data: requestId, error } = await me.supabase.rpc("request_payout_details", {
    p_party: input.party,
    p_vendor_id: input.vendorId ?? null,
    p_user_id: input.userId ?? null,
    p_line_id: input.lineId ?? null,
    p_payee_name: input.payeeName ?? null,
    p_contact_email: input.contactEmail ?? null,
    p_contact_phone: input.contactPhone ?? null,
    p_purpose: input.purpose ?? null,
    p_token_hash: hashPayoutToken(token),
  });
  if (error) return fail(said(error.message));

  const { sendPayoutDetailsLink } = await import("@/lib/payout-notify");
  const { link, sentTo } = await sendPayoutDetailsLink({ requestId: requestId as string, token });

  touch([input.path]);
  return ok({ requestId: requestId as string, link, sentTo });
}

export async function withdrawPayoutRequest(requestId: string, path?: string): Promise<ActionResult> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  const { error } = await me.supabase.rpc("withdraw_payout_request", { p_request_id: requestId });
  if (error) return fail(said(error.message));
  touch([path]);
  return ok();
}

// ── Setting and confirming an account ───────────────────────────────────────

export async function adoptRegistrationBankDetails(vendorId: string): Promise<ActionResult> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  const { data: id, error } = await me.supabase.rpc("adopt_registration_bank_details", { p_vendor_id: vendorId });
  if (error) return fail(said(error.message));

  const { notifyPayoutAccountAdded } = await import("@/lib/payout-notify");
  await notifyPayoutAccountAdded(id as string);

  touch([`/dashboard/vendors/${vendorId}`]);
  return ok();
}

export async function confirmPayoutAccountEvidence(recipientId: string, path?: string): Promise<ActionResult> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  const { error } = await me.supabase.rpc("confirm_payout_account_evidence", { p_recipient_id: recipientId });
  if (error) return fail(said(error.message));
  touch([path]);
  return ok();
}

/** A five-minute link to the payee's own document — the page the officer reads
 *  the account number off. Signed under the caller's session, so the storage
 *  policy decides (0289: the two desks that register and pay accounts). */
export async function openPayoutEvidence(recipientId: string): Promise<ActionResult<{ url: string }>> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  if (!["admin", "finance_approver"].includes(me.role)) {
    return fail("Only the payment officer or an administrator may open a payee's bank document.");
  }
  const { data: acct } = await me.supabase
    .from("payout_recipients").select("evidence_bucket, evidence_path").eq("id", recipientId).maybeSingle();
  if (!acct?.evidence_path || !acct.evidence_bucket) {
    return fail("There is no document on file for this account.");
  }
  const { data, error } = await me.supabase.storage
    .from(acct.evidence_bucket).createSignedUrl(acct.evidence_path, 300);
  if (error || !data) return fail("That document could not be opened.", "Try again in a moment.");
  return ok({ url: data.signedUrl });
}

/** The officer's own confirmation of a transfer, for the record page. */
export async function openTransferConfirmation(remittanceId: string): Promise<ActionResult<{ url: string }>> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  const { data: rec } = await me.supabase
    .from("manual_remittance_records").select("proof_path").eq("remittance_id", remittanceId).maybeSingle();
  if (!rec?.proof_path) return fail("There is no transfer confirmation on this payment.");
  const { data, error } = await me.supabase.storage.from("payout-evidence").createSignedUrl(rec.proof_path, 300);
  if (error || !data) return fail("You cannot open this confirmation.", "It is readable by finance, oversight and audit.");
  return ok({ url: data.signedUrl });
}

// ── Recording a transfer ────────────────────────────────────────────────────

export type BankTransferTarget = {
  payeeName: string;
  amount: number;
  currency: string;
  account: PayoutAccountView | null;
  nameMatches: boolean;
  /** The officer confirmed this account's document themselves, so they cannot pay it. */
  confirmedByMe: boolean;
  paidFrom: { label: string; bankName: string | null; last4: string | null } | null;
  /** Where the account is set up, when it is not ready. */
  setupHref: string;
};

type TargetInput = { payableType: BankTransferPayable; payableId: string; targetId?: string | null };

async function loadTarget(me: Me, input: TargetInput): Promise<ActionResult<BankTransferTarget>> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { payoutAccountFor } = await import("@/lib/payout-views");
  const org = me.org_id;

  let payeeName = "";
  let amount = 0;
  let currency = "NGN";
  let account: PayoutAccountView | null = null;
  let setupHref = "/dashboard/approvals";

  if (input.payableType === "vendor_payment") {
    const { data: p } = await supabaseAdmin
      .from("payments").select("id, vendor_id, amount, vendors(name)")
      .eq("id", input.payableId).eq("org_id", org).maybeSingle();
    if (!p) return fail("That payment could not be found.");
    payeeName = (p.vendors as unknown as { name?: string } | null)?.name ?? "the contractor";
    amount = Number(p.amount);
    account = await payoutAccountFor(org, { party: "vendor", vendorId: p.vendor_id });
    setupHref = `/dashboard/vendors/${p.vendor_id}`;
  } else if (input.payableType === "requisition_vendor" || input.payableType === "requisition_payee") {
    if (!input.targetId) return fail("Choose who on this requisition is being paid.");
    const column = input.payableType === "requisition_vendor" ? "vendor_id" : "payee_recipient_id";
    const { data: lines } = await supabaseAdmin
      .from("ops_requisition_lines").select("amount")
      .eq("requisition_id", input.payableId).eq("org_id", org)
      .eq(column, input.targetId).is("remittance_id", null);
    amount = (lines ?? []).reduce((s, l) => s + Number(l.amount), 0);
    if (input.payableType === "requisition_vendor") {
      const { data: v } = await supabaseAdmin
        .from("vendors").select("name").eq("id", input.targetId).eq("org_id", org).maybeSingle();
      payeeName = v?.name ?? "the contractor";
      account = await payoutAccountFor(org, { party: "vendor", vendorId: input.targetId });
      setupHref = `/dashboard/vendors/${input.targetId}`;
    } else {
      const { data: r } = await supabaseAdmin
        .from("payout_recipients").select("display_name").eq("id", input.targetId).eq("org_id", org).maybeSingle();
      payeeName = r?.display_name ?? "the payee";
      account = await payoutAccountFor(org, { party: "other", recipientId: input.targetId });
      setupHref = `/dashboard/approvals/requisitions/${input.payableId}`;
    }
  } else {
    const { data: rem } = await supabaseAdmin
      .from("remittances").select("id, net_amount, currency, payout_recipients(user_id, display_name)")
      .eq("id", input.payableId).eq("org_id", org).maybeSingle();
    if (!rem) return fail("That payout could not be found.");
    const who = rem.payout_recipients as unknown as { user_id: string | null; display_name: string } | null;
    payeeName = who?.display_name ?? "the landlord";
    amount = Number(rem.net_amount);
    currency = rem.currency;
    if (who?.user_id) {
      const { data: u } = await supabaseAdmin.from("users").select("full_name").eq("id", who.user_id).maybeSingle();
      payeeName = u?.full_name ?? payeeName;
      account = await payoutAccountFor(org, { party: "landlord", userId: who.user_id });
    }
    setupHref = "/dashboard/ledger/payouts";
  }

  const { data: bank } = await supabaseAdmin
    .from("bank_accounts").select("label, bank_name, account_number_last4")
    .eq("org_id", org).eq("purpose", "client_funds").eq("currency", currency).eq("active", true)
    .maybeSingle();

  return ok({
    payeeName,
    amount,
    currency,
    account,
    nameMatches: account ? namesAgree(account.accountName, payeeName) : true,
    confirmedByMe: Boolean(account?.verifiedById && account.verifiedById === me.id),
    paidFrom: bank ? { label: bank.label, bankName: bank.bank_name, last4: bank.account_number_last4 } : null,
    setupHref,
  });
}

/** Everything the "Record a bank transfer" form shows before anyone types. */
export async function bankTransferTarget(input: TargetInput): Promise<ActionResult<BankTransferTarget>> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  if (me.role !== "finance_approver") {
    return fail("Only the payment officer records a transfer.", "Oversight authorises; finance disburses.");
  }
  return loadTarget(me, input);
}

export async function payByBankTransfer(input: TargetInput & {
  transferredOn: string;
  bankReference: string;
  proofPath: string;
  proofFilename?: string | null;
  note?: string | null;
  /** The officer ticked "I have checked" against a name that does not match. */
  acknowledgedNameDifference?: boolean;
  path?: string;
}): Promise<ActionResult<{ remittanceId: string; told: string[] }>> {
  const me = await signedIn();
  if (!me) return fail(SESSION_EXPIRED);
  if (me.role !== "finance_approver") {
    return fail("Only the payment officer records a transfer.", "Oversight authorises; finance disburses.");
  }

  const gate = await checkRateLimit("remittance-execute", me.id, REMITTANCE_LIMIT.limit, REMITTANCE_LIMIT.window);
  if (gate.degraded) {
    return fail("The abuse-protection check for payments is unavailable right now.", "Nothing has been recorded. Try again shortly.");
  }
  if (!gate.allowed) {
    return fail("Too many payments recorded in a short time.", "Wait a few minutes and try again — this protects against a runaway session.");
  }

  if (!input.proofPath) return fail("Attach your bank's confirmation of the transfer.");

  const target = await loadTarget(me, input);
  if (!target.ok) return target;
  if (target.data.account && !target.data.nameMatches && !input.acknowledgedNameDifference) {
    return fail(
      `The account is in the name ${target.data.account.accountName}, which does not look like ${target.data.payeeName}.`,
      "Open their document and check it is theirs, then tick the box to say you have."
    );
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { newPaymentReference } = await import("@/lib/gateway");
  const { data: orgRow } = await supabaseAdmin.from("orgs").select("gateway_tag").eq("id", me.org_id).maybeSingle();
  const reference =
    input.payableType === "landlord_payout"
      ? "unused"
      : newPaymentReference(input.payableType === "vendor_payment" ? "remittance" : "requisition", orgRow?.gateway_tag ?? null);

  // The sender is PASSED, never inferred: this goes through the service role,
  // where `auth.uid()` is null by definition (0142's finding). The id is the
  // verified session's, and the database re-checks that this person may send
  // money and approved no stage of this payment.
  const { data: remittanceId, error } = await supabaseAdmin.rpc("pay_by_bank_transfer", {
    p_payable_type: input.payableType,
    p_payable_id: input.payableId,
    p_target_id: input.targetId ?? null,
    p_reference: reference,
    p_sent_by: me.id,
    p_transferred_on: input.transferredOn,
    p_bank_reference: input.bankReference,
    p_proof_path: input.proofPath,
    p_proof_filename: input.proofFilename ?? null,
    p_note: input.note ?? null,
  });
  if (error) {
    return fail(said(error.message), "Nothing has been recorded, and no money has been marked as sent.");
  }

  const { notifyPayeePaid } = await import("@/lib/payout-notify");
  const told = await notifyPayeePaid(remittanceId as string);

  const paths: (string | undefined)[] = [input.path, "/dashboard/ledger", `/dashboard/remittances/${remittanceId}`];
  if (input.payableType === "vendor_payment") paths.push(`/dashboard/payments/${input.payableId}`);
  if (input.payableType.startsWith("requisition")) paths.push(`/dashboard/approvals/requisitions/${input.payableId}`);
  touch(paths);

  return ok({ remittanceId: remittanceId as string, told });
}
