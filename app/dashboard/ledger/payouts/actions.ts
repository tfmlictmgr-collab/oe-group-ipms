"use server";

import { createClient } from "@/lib/supabase/server";
import { sendCreatedRemittance, type RemittanceOutcome } from "@/lib/remittance-run";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { checkRateLimit, REMITTANCE_LIMIT } from "@/lib/rate-limit";

// Remitting collected rent to a landlord.
//
// `create_rent_remittance` has existed since 0092b, was hardened against a
// double-payout race in 0102, and is exercised by two verification suites — and
// until now it was **called by nothing but those suites**. The accounting was
// complete and the owner had no way to be paid, which is the same shape as the
// tenant's rent screen before 0110.
//
// The sequence is the vendor one, and deliberately so:
//
//   1. authorise — finance or admin, checked here because the function below
//                  runs under the service role and would otherwise make the
//                  gate optional
//   2. create    — `create_rent_remittance` locks the collected charges, totals
//                  what was ACTUALLY paid (not what was demanded), refuses if
//                  the landlord has no verified recipient, and claims the
//                  charges so a second run cannot count them again
//   3–5. claim, send, post — `lib/remittance-run.ts`, shared with the vendor
//                  path

export type PayoutCandidate = {
  propertyId: string;
  propertyName: string;
  landlordUserId: string;
  landlordName: string;
  collected: number;
  charges: number;
  hasRecipient: boolean;
};

/**
 * What is sitting collected and unremitted, per property.
 *
 * ⚠️ Reads `rent_charges.amount_paid`, never `amount`. Remitting against a
 * demand that is merely raised would pay a landlord money no tenant has handed
 * over — the same rule `create_rent_remittance` enforces when it totals. This
 * preview must agree with it or the screen promises a figure the database will
 * refuse.
 */
export async function payoutCandidates(): Promise<ActionResult<PayoutCandidate[]>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role, org_id").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver", "executive"].includes(me.role)) {
    // An executive may LOOK — oversight sees everything finance sees (B7) —
    // and `runLandlordPayout` below still refuses them the send. Oversight
    // authorises; finance disburses.
    return fail("Only finance, an administrator or an executive can view payouts.");
  }

  const { data: rows, error } = await supabase.rpc("landlord_payout_candidates");
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  return ok(
    (rows ?? []).map(
      (r: {
        property_id: string; property_name: string;
        landlord_user_id: string; landlord_name: string;
        collected: number | string; charge_count: number; has_recipient: boolean;
      }) => ({
        propertyId: r.property_id,
        propertyName: r.property_name,
        landlordUserId: r.landlord_user_id,
        landlordName: r.landlord_name,
        collected: Number(r.collected),
        charges: Number(r.charge_count),
        hasRecipient: r.has_recipient,
      })
    )
  );
}

export async function runLandlordPayout(input: {
  propertyId: string;
  landlordUserId: string;
  period: string;
}): Promise<RemittanceOutcome> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  // 1 — authorise. `executive` is absent BY DECISION: the MD co-holds approval
  // and may never execute a disbursement (board, 29 July 2026). The database
  // refuses them too; this says so in plain words first.
  const { data: me } = await supabase
    .from("users").select("role, org_id").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver"].includes(me.role)) {
    return fail(
      "Only finance or an administrator can send a payout.",
      "Oversight authorises; finance disburses — approving against a limit you can lift yourself is not an approval."
    );
  }

  // Per-caller cap on real transfers. lib/rate-limit.ts fails open by design
  // elsewhere, but this route moves money, so a genuine Redis outage refuses
  // rather than going unguarded.
  const gate = await checkRateLimit(
    "remittance-execute", user.id, REMITTANCE_LIMIT.limit, REMITTANCE_LIMIT.window
  );
  if (gate.degraded) {
    return fail(
      "The abuse-protection check for payouts is currently unavailable.",
      "Nothing has been sent. Try again shortly."
    );
  }
  if (!gate.allowed) {
    return fail(
      "Too many payouts sent in a short window.",
      "Wait a few minutes and try again — this protects against a runaway or compromised session."
    );
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");

  // 2 — the database locks the charges, totals what was collected, and claims
  // them. Its refusals are written for a person, so they are surfaced as-is.
  const { data: remittanceId, error: createErr } = await supabaseAdmin.rpc(
    "create_rent_remittance",
    {
      p_org_id: me.org_id,
      p_landlord_user_id: input.landlordUserId,
      p_property_id: input.propertyId,
      p_period: input.period,
    }
  );
  if (createErr) {
    return fail(
      createErr.message.replace(/^.*?:\s*/, ""),
      "Nothing has been sent."
    );
  }

  return sendCreatedRemittance({
    remittanceId: remittanceId as string,
    reasonFor: (name, ref) => `Rent remittance ${ref} — ${name}`,
    revalidate: ["/dashboard/ledger/payouts", "/dashboard/ledger"],
    // No `onPosted`: unlike a vendor payment, there is no single record to
    // mark. `create_rent_remittance` already stamped `remitted_at` and
    // `remittance_id` on every charge it claimed, inside the same transaction
    // that took the lock — which is what makes the double-payout race safe.
  });
}
