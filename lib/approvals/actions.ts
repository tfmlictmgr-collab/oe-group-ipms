"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";
import type { PayableType, Decision, StageOrder } from "./chain";

/**
 * Record one stage decision on an outbound payment.
 *
 * ⚠️ Note what is NOT a parameter: the amount, the actor, the actor's role and
 * the actor's tier. All four are resolved inside `record_payment_approval` and
 * re-resolved by the trigger behind it. The only things a caller supplies are
 * WHICH payable, WHICH stage, and the decision itself — so there is no field
 * here whose value could widen the caller's own authority.
 *
 * The RPC is invoked with the caller's own session, never the service-role
 * client: `auth.uid()` is the whole basis of the separation-of-duties check,
 * and 0142 recorded what happens when a money path runs as service-role — the
 * actor is null by definition and the control silently does nothing.
 */
export async function recordStageDecision(input: {
  payableType: PayableType;
  payableId: string;
  stage: StageOrder;
  decision: Decision;
  reason?: string | null;
}): Promise<ActionResult> {
  const reason = (input.reason ?? "").trim();

  if (input.decision === "rejected" && reason.length < 10) {
    return fail(
      "Say why you are refusing this, in at least 10 characters.",
      "The person who raised it has to be able to act on the reason — a refusal nobody can act on is a dead end."
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase.rpc("record_payment_approval", {
    p_payable_type: input.payableType,
    p_payable_id: input.payableId,
    p_stage: input.stage,
    p_decision: input.decision,
    p_reason: reason || null,
  });

  if (error) return failFromDb(error, "record this decision");

  revalidatePath("/dashboard/payments");
  revalidatePath(`/dashboard/payments/${input.payableId}`);
  revalidatePath("/dashboard/ledger/payouts");
  revalidatePath("/dashboard/approvals");

  return ok();
}
