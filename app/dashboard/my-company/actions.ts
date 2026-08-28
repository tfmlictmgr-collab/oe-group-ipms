"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

/**
 * A vendor company administering itself — decision 17's UI half, which
 * `docs/VENDOR_SELF_SERVICE_SCOPE.md` §6 listed as "the only thing standing
 * between the feature and use".
 *
 * Every rule below is already enforced in the database: `current_user_vendor_ids()`
 * scopes the company, `vendor_user_can()` gates the capability, and
 * `submit_vendor_registration` / `review_vendor_registration` carry the real
 * transitions. This layer turns a refusal into a sentence, exactly as every
 * other action file here says it does.
 *
 * ⚠️ Bank details are STATED AND EVIDENCED, NEVER ACTIONABLE (decision 17).
 * A vendor types the bank's name, the account name and the LAST FOUR DIGITS,
 * and attaches the bank's own document. There is deliberately no path from
 * here into `payout_recipients` — finance reads the number off the evidence and
 * registers the payee through `0040b`, where the number goes to the gateway
 * once and is never stored. Do not add one.
 */

export type RegistrationInput = {
  legalName: string;
  tradingName: string;
  cacNumber: string;
  tin: string;
  businessType: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
};

export async function saveRegistration(
  vendorId: string,
  input: RegistrationInput
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users")
    .select("org_id")
    .eq("id", user.id)
    .single();
  if (!me) return fail("Could not resolve your profile.");

  const last4 = input.accountNumberLast4.replace(/\D/g, "");
  if (last4 && last4.length !== 4) {
    return fail(
      "Enter only the LAST FOUR digits of the account number.",
      "We never store the full number — finance reads it off the bank document you attach."
    );
  }

  const row = {
    org_id: me.org_id,
    vendor_id: vendorId,
    legal_name: input.legalName.trim() || null,
    trading_name: input.tradingName.trim() || null,
    cac_number: input.cacNumber.trim() || null,
    tin: input.tin.trim() || null,
    business_type: input.businessType.trim() || null,
    address: input.address.trim() || null,
    city: input.city.trim() || null,
    state: input.state.trim() || null,
    phone: input.phone.trim() || null,
    email: input.email.trim() || null,
    website: input.website.trim() || null,
    bank_name: input.bankName.trim() || null,
    account_name: input.accountName.trim() || null,
    account_number_last4: last4 || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("vendor_registrations")
    .upsert(row, { onConflict: "vendor_id" });
  if (error) return failFromDb(error, "save your company details");

  revalidatePath("/dashboard/my-company");
  return ok();
}

/**
 * Hands the pack to the managing organisation.
 *
 * The completeness check lives in `submit_vendor_registration`, not here — it
 * reads `vendor_registration_missing()`, which is the same list the screen
 * shows. Two copies of "what is missing" would eventually disagree, and the
 * one that refuses is the one that matters.
 */
export async function submitRegistration(): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_vendor_registration");
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/my-company");
  return ok();
}

export async function recordDocument(input: {
  vendorId: string;
  docType: string;
  storagePath: string;
  fileName: string;
  expiresOn: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users")
    .select("org_id")
    .eq("id", user.id)
    .single();
  if (!me) return fail("Could not resolve your profile.");

  // Supersede any previous document of this type rather than deleting it — a
  // document that has been looked at is evidence, and evidence that can vanish
  // is not evidence. `vendor_documents_select` still shows the current one.
  //
  // ⚠️ Through an RPC, not a direct UPDATE. A vendor holds no UPDATE policy on
  // `vendor_documents` (verification is staff-only, 0164), so the direct
  // statement this replaced matched no rows and returned NO ERROR — "Replace"
  // left two live rows of the same type and the reviewer saw whichever one the
  // screen happened to keep. `supersede_vendor_document` (0215) is SECURITY
  // DEFINER, checks manage_profile, and supersedes and nothing else.
  const { error: supErr } = await supabase.rpc("supersede_vendor_document", {
    p_vendor_id: input.vendorId,
    p_doc_type: input.docType,
  });
  // Refused means the replacement must not proceed either — otherwise the
  // second row lands beside a first that is still live, which is the state this
  // call exists to prevent.
  if (supErr) return failFromDb(supErr, "replace that document");

  const { error } = await supabase.from("vendor_documents").insert({
    org_id: me.org_id,
    vendor_id: input.vendorId,
    doc_type: input.docType,
    storage_path: input.storagePath,
    file_name: input.fileName,
    expires_on: input.expiresOn || null,
    uploaded_by: user.id,
  });
  if (error) return failFromDb(error, "attach that document");

  revalidatePath("/dashboard/my-company");
  return ok();
}

/** A vendor owner setting what one of their own people may do. */
export async function setVendorUserCapabilities(
  vendorUserId: string,
  capabilities: string[]
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vendor_users")
    .update({ capabilities })
    .eq("id", vendorUserId);
  if (error) return failFromDb(error, "change what that person may do");
  revalidatePath("/dashboard/my-company");
  return ok();
}

export async function removeVendorUser(vendorUserId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("vendor_users").delete().eq("id", vendorUserId);
  if (error) {
    // `vendor_users_keep_an_owner` refuses the removal of the last owner. That
    // is the rule working, so it is passed through rather than dressed up.
    return failFromDb(error, "remove that person");
  }
  revalidatePath("/dashboard/my-company");
  return ok();
}

/** Staff-side: approve a submitted pack, or send it back with a reason. */
export async function reviewRegistration(
  vendorId: string,
  approve: boolean,
  notes: string
): Promise<ActionResult> {
  const supabase = await createClient();
  if (!approve && notes.trim().length < 10) {
    return fail(
      "Say what needs changing.",
      "The vendor sees this verbatim — «not approved» on its own gives them nothing to act on."
    );
  }
  const { error } = await supabase.rpc("review_vendor_registration", {
    p_vendor_id: vendorId,
    p_approve: approve,
    p_notes: notes.trim() || null,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/vendors/registrations");
  return ok();
}
