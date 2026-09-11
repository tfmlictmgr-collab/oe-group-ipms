// Complete a payment's approval chain, for suites whose subject is something
// ELSE.
//
// ⚠️ Since 0151 a vendor payment reaches `approved` only as the outcome of
// three recorded stage decisions. Suites that were written before that drove
// `status = 'approved'` directly, and every one of them broke — not because the
// thing they test changed, but because the road to their starting position did.
// `verify-invoice-appeal` is about reopening a rejected invoice;
// `verify-oversight-roles` is about who may remit. Neither is about the chain,
// and neither should carry its own copy of how to satisfy it.
//
// So: one helper. If the chain's shape changes again, it changes here rather
// than in however many suites happen to need an approved payment.
//
// Uses the SERVICE ROLE deliberately — these are fixtures, not assertions. The
// chain's own rules are proven by `verify-approval-chain`, which is where a
// claim about them belongs. Note what that means, though, and it is the lesson
// that cost four suites: service-role inserts bypass RLS, so a suite built only
// on this helper proves nothing about whether a role can REACH the rows it
// governs. Assert visibility with a real signed-in session.

/**
 * Record stages 1–3 as three distinct people, so separation of duties is
 * satisfied rather than circumvented.
 *
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function clearVendorPaymentChain(svc, orgId, paymentId) {
  const pick = async (role, tier = null) => {
    let q = svc.from("users").select("id")
      .eq("org_id", orgId).eq("role", role).is("deactivated_at", null);
    if (tier !== null) q = q.eq("approval_tier", tier);
    const { data } = await q.limit(1).maybeSingle();
    return data?.id ?? null;
  };

  const fm = await pick("facility_manager");
  const auditor = await pick("payment_audit_approver");
  // Tier 3 clears any band, so a helper used by suites with arbitrary amounts
  // does not have to reason about which tier the fixture happens to need.
  const approver = (await pick("payment_approver", 3)) ?? (await pick("executive"));

  const missing = [
    !fm && "facility_manager",
    !auditor && "payment_audit_approver",
    !approver && "payment_approver (tier 3) or executive",
  ].filter(Boolean);
  if (missing.length) {
    return { ok: false, why: `no ${missing.join(", ")} in this org — run scripts/seed-org-logins.mjs` };
  }

  for (const [stage, actor] of [[1, fm], [2, auditor], [3, approver]]) {
    const { error } = await svc.from("payment_approvals").insert({
      org_id: orgId, payable_type: "vendor_payment", payable_id: paymentId,
      stage_order: stage, actor_id: actor,
      // Placeholders: enforce_approval_rules overwrites role, tier and amount
      // from the authoritative records.
      actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
    });
    if (error) return { ok: false, why: `stage ${stage}: ${error.message}` };
  }
  return { ok: true };
}

/**
 * The same, for a landlord payout — whose payable is the REMITTANCE row itself,
 * because the payout does not exist until finance assembles it (0152).
 *
 * `p_sent_by` must not be one of these three, or the maker-checker in
 * `claim_remittance_for_sending` will refuse the send.
 */
export async function clearLandlordPayoutChain(svc, orgId, remittanceId) {
  const pick = async (role, tier = null) => {
    let q = svc.from("users").select("id")
      .eq("org_id", orgId).eq("role", role).is("deactivated_at", null);
    if (tier !== null) q = q.eq("approval_tier", tier);
    const { data } = await q.limit(1).maybeSingle();
    return data?.id ?? null;
  };

  const fm = await pick("facility_manager");
  const auditor = await pick("payment_audit_approver");
  const approver = (await pick("payment_approver", 3)) ?? (await pick("executive"));
  if (!fm || !auditor || !approver) {
    return { ok: false, why: "the org lacks one of the three chain roles — run scripts/seed-org-logins.mjs" };
  }

  for (const [stage, actor] of [[1, fm], [2, auditor], [3, approver]]) {
    const { error } = await svc.from("payment_approvals").insert({
      org_id: orgId, payable_type: "landlord_payout", payable_id: remittanceId,
      stage_order: stage, actor_id: actor,
      actor_role: "viewer", actor_tier: null, amount: 1, decision: "approved",
    });
    if (error) return { ok: false, why: `stage ${stage}: ${error.message}` };
  }
  return { ok: true };
}
