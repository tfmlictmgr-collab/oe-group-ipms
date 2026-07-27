"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// Registering where a vendor gets paid.
//
// The account number is sent to the gateway and NOT stored. What comes back is
// a recipient code, and that code is the only thing money can ever be sent to.
// So the gateway — not this application — is the system of record for where
// money goes, and a database compromise here yields no payable account details.
// Only the last four digits are kept, which is all a person needs to recognise
// the account on a statement (the same rule as bank_accounts in 0028).
//
// The gateway performs a name enquiry against the bank. The name it returns is
// the account's REAL holder and is what gets stored — never the name someone
// typed into the form. If those disagree, that is exactly the discrepancy an
// administrator should see before any money moves.

export type RecipientInput = {
  vendorId: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
};

export type SaveRecipientResult = ActionResult<{
  resolvedName: string;
  last4: string;
  nameMatches: boolean;
}>;

export async function saveVendorPayoutRecipient(
  input: RecipientInput
): Promise<SaveRecipientResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id, role").eq("id", user.id).single();
  // Bank details decide where money lands. Configuration, not operations — the
  // same separation as bank_accounts: an admin defines it, finance uses it.
  if (!me || me.role !== "admin") {
    return fail("Only an administrator can set a vendor's bank details.");
  }

  const accountNumber = input.accountNumber.replace(/\s/g, "");
  if (!/^\d{10}$/.test(accountNumber)) {
    return fail("A Nigerian account number is 10 digits.");
  }
  if (!/^\d{3,6}$/.test(input.bankCode.trim())) {
    return fail("Choose the vendor's bank.");
  }

  const { data: vendor } = await supabase
    .from("vendors").select("id, name, org_id").eq("id", input.vendorId).single();
  if (!vendor) return fail("That vendor could not be found.");

  const { getGateway } = await import("@/lib/gateway");
  const gateway = getGateway("NGN");

  const created = await gateway.createRecipient({
    name: input.accountName.trim() || vendor.name,
    accountNumber,
    bankCode: input.bankCode.trim(),
    currency: "NGN",
  });

  if (!created.ok || !created.recipientCode) {
    return fail(
      `The bank could not confirm that account: ${created.error ?? "no reason given"}`,
      "Check the account number and the bank. Nothing has been saved."
    );
  }

  const resolvedName = created.resolvedName ?? input.accountName.trim();
  const last4 = accountNumber.slice(-4);

  const { supabaseAdmin } = await import("@/lib/supabase/admin");

  // Supersede rather than edit: a payout recipient that has been used is
  // referenced by remittances, and rewriting it would silently restate where
  // past money went.
  await supabaseAdmin
    .from("payout_recipients")
    .update({ active: false })
    .eq("org_id", vendor.org_id)
    .eq("party", "vendor")
    .eq("vendor_id", vendor.id)
    .eq("active", true);

  const { error } = await supabaseAdmin.from("payout_recipients").insert({
    org_id: vendor.org_id,
    party: "vendor",
    vendor_id: vendor.id,
    display_name: resolvedName,
    account_name: resolvedName,
    account_number_last4: last4,
    gateway: gateway.name === "simulated" ? "paystack" : gateway.name,
    recipient_code: created.recipientCode,
    currency: "NGN",
    verified_at: new Date().toISOString(),
    created_by: user.id,
  });
  if (error) return failFromDb(error, "save these bank details");

  revalidatePath(`/dashboard/vendors/${vendor.id}`);
  return ok({
    resolvedName,
    last4,
    // Surfaced rather than enforced: a legitimate mismatch exists (a trading
    // name against a registered one), and a person should decide.
    nameMatches:
      resolvedName.trim().toLowerCase() === (input.accountName.trim() || vendor.name).toLowerCase(),
  });
}

/**
 * The banks the gateway will accept, for the picker.
 *
 * Fetched live rather than hardcoded: Nigerian bank codes change as institutions
 * merge, are licensed, or are absorbed, and a stale local list produces a
 * transfer that fails at the bank rather than in the form. Falls back to a short
 * list of the largest banks only when the gateway cannot be reached, so an
 * outage degrades the choice rather than blocking onboarding entirely.
 */
export async function listBanks(): Promise<ActionResult<{ code: string; name: string }[]>> {
  const key = process.env.PAYSTACK_SECRET_KEY;

  if (!key) {
    return ok([
      { code: "058", name: "Guaranty Trust Bank" },
      { code: "011", name: "First Bank of Nigeria" },
      { code: "044", name: "Access Bank" },
      { code: "057", name: "Zenith Bank" },
      { code: "033", name: "United Bank for Africa" },
      { code: "070", name: "Fidelity Bank" },
      { code: "232", name: "Sterling Bank" },
      { code: "101", name: "Providus Bank" },
    ]);
  }

  try {
    const res = await fetch("https://api.paystack.co/bank?currency=NGN&perPage=100", {
      headers: { Authorization: `Bearer ${key}` },
      // Bank lists change rarely; re-fetching per page load is waste.
      next: { revalidate: 86_400 },
    });
    const json = (await res.json()) as {
      status?: boolean;
      data?: { code: string; name: string }[];
    };
    if (!res.ok || !json.status || !json.data) {
      return fail("The list of banks could not be loaded. Try again shortly.");
    }
    return ok(
      json.data
        .map((b) => ({ code: b.code, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch {
    return fail("The list of banks could not be loaded. Try again shortly.");
  }
}
