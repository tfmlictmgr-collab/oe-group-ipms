"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * An FM/PM raising work themselves.
 *
 * Standing, property scope and the optional dispatch are all decided in
 * `raise_work_order` (0120) — this passes through and surfaces the function's
 * own refusal, which names the actual reason ("that property is not one you
 * manage", "that asset is not on that property") rather than a generic
 * failure the person cannot act on.
 */
export async function raiseWorkOrder(input: {
  propertyId: string;
  summary: string;
  detail: string | null;
  category: string;
  urgency: string;
  assetId: string | null;
  vendorId: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("raise_work_order", {
    p_property_id: input.propertyId,
    p_summary: input.summary,
    p_detail: input.detail,
    p_category: input.category,
    p_urgency: input.urgency,
    p_asset_id: input.assetId,
    p_vendor_id: input.vendorId,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/dashboard");
  return ok({ id: data as string });
}
