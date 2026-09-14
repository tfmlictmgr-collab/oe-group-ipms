// Complete a payment's approval chain, for suites whose subject is something
// ELSE.
//
// ⚠️ Since 0151 a vendor payment reaches `approved` only as the outcome of
// three recorded stage decisions. Suites that were written before that drove
// `status = 'approved'` directly, and every one of them broke — not because the
// thing they test changed, but because the road to their starting position did.
// So: one helper. If the chain's shape changes again, it changes here rather
// than in however many suites happen to need an approved payment.
//
// ⚠️ 12 Sept 2026 — every decision is now made by a REAL SIGNED-IN PERSON,
// through `record_payment_approval`, and no longer inserted with the service
// role. The service-role inserts were invisible in the table and very visible
// in the audit trail: `log_audit` stamps `auth.uid()`, which is null for the
// service role, so 1,306 approval decisions — every one of them this helper's
// — sat on the live trail as "System", looking to an auditor exactly like
// decisions nobody could be traced to. The trail is immutable, so those rows
// are labelled on the page rather than removed; this makes sure there are no
// more of them. Each decision is now attributed to the demo login that made it,
// which the trail labels "Demo account".
//
// It also means this helper now goes through the chain's own rules — the stage
// order, the role each stage needs, one human per stage, the tier — instead of
// around them. A suite that relied on the service role skipping one of those
// was relying on something the product never allows.

import { createClient } from "@supabase/supabase-js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "OEGroupDemo2026!";

async function signedInAs(email) {
  const c = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error } = await c.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  return error ? null : c;
}

/**
 * Who decides each stage of this organisation's chain — read from
 * `payment_chain_stages(org)`, so the standard ladder, OEA's and a single-stage
 * chain (decision 28) are all walked as they actually are.
 *
 * A demo login, never a `probe*` account another run left behind (decision 38:
 * 214 of them once held real roles, with passwords nobody here knows), and never
 * the same person twice — one human, one stage. The highest tier first, so a
 * fixture of any amount clears the band.
 */
async function deciders(svc, orgId) {
  const { data: stages, error } = await svc.rpc("payment_chain_stages", { p_org_id: orgId });
  if (error || !stages?.length) {
    return { ok: false, why: `could not read this organisation's approval chain: ${error?.message ?? "no stages"}` };
  }
  const used = new Set();
  const out = [];
  for (const s of [...stages].sort((a, b) => a.stage_order - b.stage_order)) {
    let chosen = null;
    for (const role of s.required_roles) {
      const { data } = await svc
        .from("users")
        .select("id, email, approval_tier")
        .eq("org_id", orgId)
        .eq("role", role)
        .is("deactivated_at", null)
        .not("email", "like", "probe%")
        .order("created_at");
      const candidates = (data ?? [])
        .filter((u) => !used.has(u.id))
        .sort((a, b) => (b.approval_tier ?? 0) - (a.approval_tier ?? 0));
      for (const u of candidates) {
        const c = await signedInAs(u.email);
        if (c) {
          chosen = { stage: s.stage_order, id: u.id, email: u.email, client: c };
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      return {
        ok: false,
        why: `nobody who can sign in holds stage ${s.stage_order} (${s.required_roles.join(" or ")}) in this organisation — run scripts/seed-org-logins.mjs`,
      };
    }
    used.add(chosen.id);
    out.push(chosen);
  }
  return { ok: true, deciders: out };
}

/**
 * Record every stage of a payable's chain as approved, each by a different
 * signed-in person.
 *
 * @returns {Promise<{ok: boolean, why?: string, actors?: string[]}>}
 */
async function clearChain(svc, orgId, payableType, payableId) {
  const d = await deciders(svc, orgId);
  if (!d.ok) return d;
  try {
    for (const { stage, email, client } of d.deciders) {
      const { error } = await client.rpc("record_payment_approval", {
        p_payable_type: payableType,
        p_payable_id: payableId,
        p_stage: stage,
        p_decision: "approved",
      });
      if (error) return { ok: false, why: `stage ${stage} (${email}): ${error.message}` };
    }
    return { ok: true, actors: d.deciders.map((x) => x.id) };
  } finally {
    await Promise.all(d.deciders.map((x) => x.client.auth.signOut().catch(() => {})));
  }
}

/** A vendor payment's chain. The payment must already be at the chain. */
export function clearVendorPaymentChain(svc, orgId, paymentId) {
  return clearChain(svc, orgId, "vendor_payment", paymentId);
}

/**
 * The same, for a landlord payout — whose payable is the REMITTANCE row itself,
 * because the payout does not exist until finance assembles it (0152).
 *
 * The person who then sends it must not be one of the deciders, or the
 * maker-checker in `claim_remittance_for_sending` refuses — the returned
 * `actors` says who they were.
 */
export function clearLandlordPayoutChain(svc, orgId, remittanceId) {
  return clearChain(svc, orgId, "landlord_payout", remittanceId);
}
