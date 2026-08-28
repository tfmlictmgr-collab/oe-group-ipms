"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendCreatedRemittance, type RemittanceOutcome } from "@/lib/remittance-run";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
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
    // and `sendApprovedPayout` below still refuses them the send. Oversight
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

/**
 * RAISE a landlord payout. It does not send.
 *
 * ⚠️ This used to create and send in one call. Since 0151/0152 a landlord
 * payout climbs the same three-stage chain as a vendor invoice, so the run is
 * two acts with other people's decisions in between: finance assembles the
 * payout (locking and claiming the collected charges, which is why it must stay
 * a single atomic step), the chain approves it, and only then does
 * `sendApprovedPayout` release it.
 *
 * Keeping them fused would have meant every payout failing at the send step
 * with "0 of 3 approval stages" — the control technically enforced and the
 * feature unusable.
 */
export async function raiseLandlordPayout(input: {
  propertyId: string;
  landlordUserId: string;
  period: string;
}): Promise<ActionResult<{ remittanceId: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role, org_id").eq("id", user.id).single();
  if (!me || me.role !== "finance_approver") {
    return fail(
      "Only the payment officer can raise a payout.",
      "Oversight authorises; finance disburses."
    );
  }

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data: remittanceId, error } = await supabaseAdmin.rpc(
    "create_rent_remittance",
    {
      p_org_id: me.org_id,
      p_landlord_user_id: input.landlordUserId,
      p_property_id: input.propertyId,
      p_period: input.period,
      p_executed_by: user.id,
    }
  );
  if (error) {
    return fail(error.message.replace(/^.*?:\s*/, ""), "Nothing has been raised.");
  }

  revalidatePath("/dashboard/ledger/payouts");
  revalidatePath("/dashboard/approvals");
  return ok({ remittanceId: remittanceId as string });
}

export type RaisedPayout = {
  remittanceId: string;
  reference: string;
  propertyName: string;
  landlordName: string;
  netAmount: number;
  period: string | null;
  raisedAt: string;
};

/**
 * Landlord payouts that have been RAISED and not yet sent.
 *
 * ⚠️ This list is why the split into raise/send is usable at all. Raising a
 * payout claims the collected rent charges (`create_rent_remittance` stamps
 * `remitted_at` and `remittance_id` on every one it takes), so the property
 * immediately drops out of `payoutCandidates()` — and until this existed there
 * was no second screen for it to appear on, no caller of `sendApprovedPayout`
 * anywhere in the app, and therefore no route by which a landlord's money could
 * leave once it had been claimed. It could only be raised and stranded.
 *
 * Every row is shown, whether or not its chain is complete, with its own trail:
 * a payout waiting on an approver and a payout waiting on finance are different
 * situations and the difference is the only useful thing on the row. Only the
 * cleared ones get a Send button, and `claim_remittance_for_sending` re-checks
 * that regardless of what this renders.
 */
export async function raisedPayouts(): Promise<ActionResult<RaisedPayout[]>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || !["admin", "finance_approver", "executive"].includes(me.role)) {
    return fail("Only finance, an administrator or an executive can view payouts.");
  }

  // RLS scopes this to the caller's own org; `queued` with no ledger entry is
  // "raised, not yet gone".
  const { data, error } = await supabase
    .from("remittances")
    .select(
      "id, reference, net_amount, period, created_at, properties(name), payout_recipients(display_name)"
    )
    .eq("party", "landlord")
    .eq("status", "queued")
    .is("ledger_entry_id", null)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) return failFromDb(error, "list payouts awaiting release");

  // PostgREST types an embedded parent as an array even where the foreign key
  // makes it one row at most.
  const one = <T,>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

  return ok(
    (data ?? []).map((r) => ({
      remittanceId: r.id,
      reference: r.reference,
      propertyName: one(r.properties as { name?: string } | { name?: string }[] | null)?.name
        ?? "A property",
      landlordName: one(
        r.payout_recipients as { display_name?: string } | { display_name?: string }[] | null
      )?.display_name ?? "the landlord",
      netAmount: Number(r.net_amount),
      period: r.period ?? null,
      raisedAt: r.created_at,
    }))
  );
}

/**
 * SEND a payout that has cleared the chain. The database re-checks every part
 * of that — completion, the amount it was approved at, finance authority, and
 * that the sender approved no stage of it.
 */
export async function sendApprovedPayout(
  remittanceId: string
): Promise<RemittanceOutcome> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: me } = await supabase
    .from("users").select("role").eq("id", user.id).single();
  if (!me || me.role !== "finance_approver") {
    return fail(
      "Only the payment officer can send a payout.",
      "Oversight authorises; finance disburses."
    );
  }

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

  return sendCreatedRemittance({
    remittanceId,
    sentBy: user.id,
    reasonFor: (name, ref) => `Rent remittance ${ref} — ${name}`,
    revalidate: ["/dashboard/ledger/payouts", "/dashboard/ledger"],
  });
}
