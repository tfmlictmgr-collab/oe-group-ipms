"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Admin-configurable payment gate thresholds (B7: admin configures limits).
// RLS restricts writes to admins; this action just passes the values through.
export async function updatePaymentSettings(
  orgId: string,
  minPerformanceScore: number,
  approvalThresholdAmount: number
) {
  const supabase = await createClient();
  const { error } = await supabase.from("payment_settings").upsert({
    org_id: orgId,
    min_performance_score: minPerformanceScore,
    approval_threshold_amount: approvalThresholdAmount,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/settings");
}
