"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

export type EvaluationAnswer = { criterionId: string; value: string };

/**
 * Submits one source's half of a job's evaluation. Everything that decides
 * whether this is ALLOWED and what the scores actually ARE happens inside
 * `submit_vendor_evaluation()` (0104) — this action's only job is to shape the
 * input and turn the function's own refusal into something readable. There is
 * no other write path to `vendor_evaluations`; the direct-insert policy that
 * used to back the free-typed form was dropped in the same migration.
 */
export async function submitEvaluation(
  ticketId: string,
  source: "tenant" | "fm_pm",
  answers: EvaluationAnswer[]
): Promise<ActionResult<{ evaluationId: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { data: evaluationId, error } = await supabase.rpc("submit_vendor_evaluation", {
    p_ticket_id: ticketId,
    p_source: source,
    p_responses: answers.map((a) => ({ criterionId: a.criterionId, value: a.value })),
  });

  if (error) {
    // The function's own refusals are written for a person to read.
    if (/permission|only the person|permission to evaluate/i.test(error.message)) {
      return fail("You are not able to submit this review.", error.message);
    }
    return failFromDb(error, "submit this evaluation");
  }

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath("/dashboard/my-requests");
  revalidatePath("/dashboard/vendors");
  return ok({ evaluationId: evaluationId as string });
}
