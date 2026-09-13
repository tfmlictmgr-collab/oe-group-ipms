"use server";

import { randomUUID } from "node:crypto";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { checkRateLimit } from "@/lib/rate-limit";

// The payee's side of 0289. No session — the token in the address is the whole
// authority, re-checked on every call, and only its hash is ever compared.
//
// ⚠️ The account number comes here once, is used to ask the bank whose it is,
// and is dropped. Nothing below stores it, logs it, or returns it.

type Open = { request_id: string; org_id: string; state: string; party: string };

async function openRequest(token: string): Promise<Open | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { hashPayoutToken } = await import("@/lib/payout-evidence");
  const { data } = await supabaseAdmin.rpc("payout_request_by_token", {
    p_token_hash: hashPayoutToken(decodeURIComponent(token ?? "")),
  });
  const row = (Array.isArray(data) ? data[0] : data) as Open | undefined;
  return row && row.state === "open" ? row : null;
}

const GONE = "This link is no longer open. Ask whoever sent it for a new one.";

/** Per link, not per address: a phone on a site's shared wi-fi is many people. */
async function limited(token: string): Promise<boolean> {
  const { hashPayoutToken } = await import("@/lib/payout-evidence");
  const r = await checkRateLimit("payout-details", hashPayoutToken(token), 20, "10 m");
  return !r.allowed;
}

export async function checkAccountName(
  token: string,
  accountNumber: string,
  bankCode: string
): Promise<ActionResult<{ accountName: string | null; confirmed: boolean; note: string | null }>> {
  if (await limited(token)) return fail("Too many checks in a short time.", "Wait a few minutes and try again.");
  const req = await openRequest(token);
  if (!req) return fail(GONE);

  const { lookUpAccountName } = await import("@/lib/bank-resolve");
  const found = await lookUpAccountName(req.org_id, accountNumber, bankCode);
  if (found.ok) return ok({ accountName: found.accountName, confirmed: true, note: null });
  if (found.unavailable) return ok({ accountName: null, confirmed: false, note: found.reason });
  return fail(found.reason);
}

export async function prepareEvidenceUpload(
  token: string,
  file: { name: string; size: number; type: string }
): Promise<ActionResult<{ path: string; uploadToken: string }>> {
  if (await limited(token)) return fail("Too many attempts in a short time.", "Wait a few minutes and try again.");
  const req = await openRequest(token);
  if (!req) return fail(GONE);

  const { payoutEvidenceProblem, safeFileName, PAYOUT_BUCKET } = await import("@/lib/payout-evidence");
  const problem = payoutEvidenceProblem(file);
  if (problem) return fail(problem);

  const path = `${req.org_id}/requests/${req.request_id}/${randomUUID()}-${safeFileName(file.name)}`;
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data, error } = await supabaseAdmin.storage.from(PAYOUT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return fail("The upload could not be prepared.", "Try again in a moment.");
  return ok({ path, uploadToken: data.token });
}

export async function submitPayoutDetails(input: {
  token: string;
  bankCode: string;
  accountNumber: string;
  typedAccountName: string;
  evidencePath: string;
  evidenceFilename: string;
}): Promise<ActionResult<{ bankName: string; last4: string; confirmed: boolean }>> {
  if (await limited(input.token)) return fail("Too many attempts in a short time.", "Wait a few minutes and try again.");
  const req = await openRequest(input.token);
  if (!req) return fail(GONE);

  const number = (input.accountNumber ?? "").replace(/\D/g, "");
  if (number.length !== 10) return fail("A Nigerian account number is 10 digits.");

  // The bank's own name for its code, from the one bank list — never a name
  // the browser sent.
  const { listBanks } = await import("@/lib/bank-actions");
  const banks = await listBanks();
  const bankName = banks.ok ? banks.data.find((b) => b.code === input.bankCode)?.name : undefined;
  if (!bankName) return fail("Choose your bank from the list.");

  // Asked AGAIN here, rather than trusting what the page showed: the name that
  // is stored is the bank's, whenever the bank can be asked.
  const { lookUpAccountName } = await import("@/lib/bank-resolve");
  const found = await lookUpAccountName(req.org_id, number, input.bankCode);
  let accountName: string;
  let confirmed = false;
  if (found.ok) {
    accountName = found.accountName;
    confirmed = true;
  } else if (found.unavailable) {
    accountName = (input.typedAccountName ?? "").trim();
    if (accountName.length < 3) return fail("Type the account name exactly as your bank shows it.");
  } else {
    return fail(found.reason);
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { hashPayoutToken } = await import("@/lib/payout-evidence");
  const { data: recipientId, error } = await supabaseAdmin.rpc("submit_payout_details", {
    p_token_hash: hashPayoutToken(decodeURIComponent(input.token)),
    p_bank_name: bankName,
    p_bank_code: input.bankCode,
    p_account_name: accountName,
    p_last4: number.slice(-4),
    p_name_confirmed: confirmed,
    p_evidence_path: input.evidencePath,
    p_evidence_filename: input.evidenceFilename,
  });
  if (error) {
    const said = error.message.replace(/^.*?ERROR:\s*/i, "").trim();
    return fail(said.charAt(0).toUpperCase() + said.slice(1));
  }

  const { notifyPayoutAccountAdded, notifyRequesterSubmitted } = await import("@/lib/payout-notify");
  await Promise.all([
    notifyPayoutAccountAdded(recipientId as string),
    notifyRequesterSubmitted(req.request_id),
  ]);

  return ok({ bankName, last4: number.slice(-4), confirmed });
}
