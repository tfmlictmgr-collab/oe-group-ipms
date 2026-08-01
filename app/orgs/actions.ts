"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ORG_DOMAIN_TAG } from "@/lib/org-host";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Binds a hostname to an organisation, or frees it when given an empty string.
 *
 * The authority check lives in `set_org_domain` — operator-only and audited to
 * `operator_actions`. This layer adds the one thing Postgres cannot: busting the
 * host→org cache, so the new mapping is live on the next request rather than up
 * to an hour later.
 */
export async function setOrgDomain(
  orgId: string,
  domain: string,
  reason: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_org_domain", {
    p_org_id: orgId,
    p_domain: domain.trim(),
    p_reason: reason,
  });
  if (error) return fail(error.message.replace(/^.*?:\s*/, ""));

  // Every host lookup shares one tag: a domain moving between orgs must not
  // leave the old host resolving to the old org from cache.
  revalidateTag(ORG_DOMAIN_TAG);
  revalidatePath("/orgs");
  return ok();
}
