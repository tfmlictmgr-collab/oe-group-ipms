"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, failFromDb, type ActionResult } from "@/lib/action-result";

// The KPI/SLA rubric admins edit. Every write goes through a SECURITY DEFINER
// function that re-checks admin + org itself (see 0104) — these actions add
// input shaping and turn a database refusal into something readable, they are
// not themselves the boundary.

export async function ensureRubric(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");
  const { data: me } = await supabase.from("users").select("org_id").eq("id", user.id).single();
  if (!me) return fail("Could not resolve your profile.");

  const { error } = await supabase.rpc("ensure_default_evaluation_criteria", { p_org_id: me.org_id });
  if (error) return failFromDb(error, "set up the evaluation rubric");
  revalidatePath("/dashboard/settings/evaluation");
  return ok();
}

export type EditCriterionInput = {
  id: string;
  label: string;
  maxPoints: number;
  slaTargetHours?: number | null;
};

export async function editCriterion(input: EditCriterionInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const label = input.label.trim();
  if (label.length < 4) return fail("Give the checklist item a clearer label.");
  if (!Number.isFinite(input.maxPoints) || input.maxPoints <= 0) {
    return fail("Points must be a positive number.");
  }
  if (input.slaTargetHours != null && (!Number.isFinite(input.slaTargetHours) || input.slaTargetHours <= 0)) {
    return fail("The SLA target must be a positive number of hours.");
  }

  const { error } = await supabase.rpc("edit_evaluation_criterion", {
    p_old_id: input.id,
    p_label: label,
    p_max_points: input.maxPoints,
    p_sla_target_hours: input.slaTargetHours ?? null,
  });
  if (error) return failFromDb(error, "edit that checklist item");
  revalidatePath("/dashboard/settings/evaluation");
  return ok();
}

export async function retireCriterion(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("Your session expired. Please sign in again.");

  const { error } = await supabase.rpc("retire_evaluation_criterion", { p_id: id });
  if (error) return failFromDb(error, "remove that checklist item");
  revalidatePath("/dashboard/settings/evaluation");
  return ok();
}
