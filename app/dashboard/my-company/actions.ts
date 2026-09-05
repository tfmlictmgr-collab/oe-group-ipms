"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  generateInviteToken,
  hashInviteToken,
  buildInviteUrl,
  sendInviteEmail,
} from "@/lib/invitation";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import {
  isAssignableVendorRole,
  capabilitiesForVendorRole,
} from "@/lib/vendor-roles";

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
  /** The declaration text AS SHOWN on screen, stored verbatim. */
  complianceStatement: string;
  declareCompliance: boolean;
};

export async function saveRegistration(
  vendorId: string,
  input: RegistrationInput
): Promise<ActionResult> {
  const supabase = await createClient();

  // ⚠️ Through an RPC, not a table upsert.
  //
  // The upsert this replaced could only ever INSERT. `authenticated` held
  // `select, insert` on `vendor_registrations` and no UPDATE grant, while a
  // `vendor_registrations_update` POLICY existed — Postgres needs both — so the
  // first save worked and every later one died on "permission denied for table
  // vendor_registrations". A vendor could enter their details once and never
  // correct a typo.
  //
  // ⚠️ And the insert policy constrained the row's ORG but not its STATUS, so a
  // vendor could file their own registration as `approved`. Confirmed by
  // attempting it. `save_vendor_registration` (0216) never takes status from a
  // caller at all, which is why the table write is gone rather than widened.
  const { error } = await supabase.rpc("save_vendor_registration", {
    p_vendor_id: vendorId,
    p_legal_name: input.legalName,
    p_trading_name: input.tradingName,
    p_cac_number: input.cacNumber,
    p_tin: input.tin,
    p_business_type: input.businessType,
    p_address: input.address,
    p_city: input.city,
    p_state: input.state,
    p_phone: input.phone,
    p_email: input.email,
    p_website: input.website,
    p_bank_name: input.bankName,
    p_account_name: input.accountName,
    p_account_number_last4: input.accountNumberLast4,
    // Stored verbatim per vendor, so a later change to the wording never
    // rewrites what somebody actually agreed to (decision 10's rule for
    // consent copy).
    p_compliance_statement: input.complianceStatement,
    p_declare_compliance: input.declareCompliance,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

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

/**
 * A vendor setting one of their own people's ROLE.
 *
 * ⚠️ Takes a role and expands it HERE, never a capability list from the
 * browser. The previous signature accepted `capabilities: string[]` and wrote
 * it straight through, so the client chose the permission set; RLS bounded
 * WHICH membership could be written but not WHAT it was written to. Roles are
 * a closed set of two, expanded server-side against `lib/vendor-roles.ts`, so
 * a crafted request can no longer mint a combination the product never offers
 * — `manage_profile` alone, for instance, which edits the registration
 * evidence a managing organisation verified.
 *
 * `owner` is absent from the assignable set on purpose: `is_owner` is refused
 * to this caller by `vendor_users_update_is_capabilities_only`, which admits
 * only a holder of `vendors.write` — the managing organisation. Offering it
 * here would be offering a button the database exists to refuse.
 */
export async function setVendorUserRole(
  vendorUserId: string,
  role: string
): Promise<ActionResult> {
  if (!isAssignableVendorRole(role)) {
    return fail(
      "That is not a role you can assign.",
      "Ownership is changed by the managing organisation, not from this screen."
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("vendor_users")
    .update({ capabilities: capabilitiesForVendorRole(role) })
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

/**
 * A vendor owner (or anyone else holding `manage_users`) inviting a colleague
 * into their OWN company. The database side has existed since 0163 —
 * `invitations_insert_by_vendor_user` already permits exactly this — but
 * nothing on this screen ever called it: the "Manage people" pill's own hint
 * text ("Invite colleagues and set what they may do") named a feature that
 * had no form behind it. This is that form's server half.
 *
 * Deliberately its OWN action rather than a widened `inviteMember` — a vendor
 * colleague is a PEER within the same company, not a subordinate in an org's
 * rank hierarchy (`ROLE_RANK["vendor"]` is not even meaningfully comparable to
 * itself), so it does not belong on that action's seniority logic. It mirrors
 * only the parts that ARE shared: token issuance, the re-invite-replaces-stale
 * behaviour, and the email.
 */
export async function inviteVendorColleague(
  email: string,
  fullName: string,
  role: string
): Promise<ActionResult<{ url: string; accepted: boolean }>> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("org_id, role, full_name").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");
  if (me.role !== "vendor") {
    return fail("Only a vendor company may invite its own colleagues here.");
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return fail("Enter a valid email address.");
  }
  // Expanded from the role server-side, so the set written is one of exactly
  // two the product offers. The old code filtered a client-supplied array
  // against the four legal keys, which kept it well-formed without keeping it
  // OFFERED — every subset of the four was reachable by hand.
  //
  // An empty set can no longer occur (both roles grant at least `manage_work`),
  // but the check stays: it is the rule the RLS policy also enforces, and an
  // empty set is what makes a FIRST login an owner — which this never is.
  if (!isAssignableVendorRole(role)) {
    return fail(
      "Choose what this person may do.",
      "Member for the work itself, Admin to also run the company\u2019s people and contracts."
    );
  }

  const { data: vendorId, error: vendorErr } = await supabase.rpc("current_user_vendor_id");
  if (vendorErr || !vendorId) {
    return fail("You are not attached to a vendor company.");
  }

  const existing = await supabase
    .from("users").select("id").eq("email", cleanEmail).maybeSingle();
  if (existing.data) {
    return fail(
      "That person is already a platform member.",
      "An existing login cannot be re-invited into a second company from here."
    );
  }

  // Re-inviting replaces any live invitation for this email INTO THIS company,
  // rather than colliding with it. Scoped to `vendor_id` so a stray email match
  // can never revoke a staff invitation this vendor has no business touching.
  await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("org_id", me.org_id)
    .eq("vendor_id", vendorId as string)
    .eq("status", "pending")
    .ilike("email", cleanEmail);

  const token = generateInviteToken();
  const { data: invitation, error } = await supabase.from("invitations").insert({
    org_id: me.org_id,
    email: cleanEmail,
    role: "vendor",
    full_name: fullName.trim() || null,
    vendor_id: vendorId,
    vendor_capabilities: capabilitiesForVendorRole(role),
    token_hash: hashInviteToken(token),
    invited_by: user.id,
  }).select("id").single();
  // `invitations_insert_by_vendor_user` is the real gate — this is a company
  // inviting into itself, so a refusal here almost always means the scope
  // slipped (an id from another company, say), not a permission question a
  // vendor could act on. Passed through rather than reworded.
  if (error) return failFromDb(error, "issue that invitation");

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const url = buildInviteUrl(origin, token);

  const { data: org } = await supabase
    .from("orgs").select("delivery_brand").eq("id", me.org_id).single();

  const accepted = await sendInviteEmail(
    cleanEmail, url, "vendor", me.org_id, org?.delivery_brand ?? null,
    me.full_name ?? null, invitation?.id ?? null
  );

  revalidatePath("/dashboard/my-company");
  return ok({ url, accepted });
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

/**
 * Carrying an approved registration to another organisation on the platform
 * (0165, `manage_contracts`). By slug — the same "you can act on an address
 * you were given, not discover one from a list" rule `org_public_branding`
 * follows — and the consent text is stored VERBATIM on the offer, exactly as
 * `saveRegistration`'s compliance declaration is.
 */
export async function offerIntroduction(
  targetOrgSlug: string,
  consentStatement: string
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("offer_vendor_introduction", {
    p_target_org_slug: targetOrgSlug.trim(),
    p_consent_statement: consentStatement,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/my-company");
  return ok({ id: data as string });
}

/** Withdrawable until the receiving org acts on it — consent that cannot be taken back is not consent. */
export async function withdrawIntroduction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("withdraw_vendor_introduction", { p_id: id });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/my-company");
  return ok();
}

/** Staff-side: take on a registration a vendor has offered to carry here. */
export async function acceptIntroduction(id: string): Promise<ActionResult<{ vendorId: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_vendor_introduction", { p_id: id });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/vendors/introductions");
  revalidatePath("/dashboard/vendors/registrations");
  return ok({ vendorId: data as string });
}

/** Staff-side: decline an offer. The contractor sees the reason verbatim. */
export async function declineIntroduction(id: string, notes: string): Promise<ActionResult> {
  const supabase = await createClient();
  if (notes.trim().length < 10) {
    return fail(
      "Say why.",
      "Recorded on the offer so the contractor is told something they can act on."
    );
  }
  const { error } = await supabase.rpc("decline_vendor_introduction", {
    p_id: id,
    p_notes: notes.trim(),
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));
  revalidatePath("/dashboard/vendors/introductions");
  return ok();
}
