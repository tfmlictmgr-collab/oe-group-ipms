"use server";

import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { probeProviders, type ProviderHealth } from "@/lib/llm";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Asks each provider to answer a tiny prompt, right now.
 *
 * Admin-only, and gated here rather than only in the page: a server action is
 * a public endpoint, and this one spends money (one request per provider) and
 * reports infrastructure state. Neither belongs to a tenant.
 */
export async function testProviders(): Promise<ActionResult<{ health: ProviderHealth[] }>> {
  const session = await getSessionProfile();
  if (session?.profile?.role !== "admin") {
    return fail("Only an administrator can test the classification providers.");
  }
  const health = await probeProviders();
  return ok({ health });
}

/**
 * How much of the recent classification load each provider carried.
 *
 * This is the question the health probe cannot answer: a provider can be
 * reachable *now* and have been failing for a day. `tickets.classified_by`
 * (0113) records which model actually answered for each ticket, so a run of
 * `gemini` — or worse, `none` — is visible after the fact rather than only
 * while it is happening.
 */
export async function recentClassifierMix(): Promise<
  ActionResult<{ mix: { provider: string; count: number }[]; since: string }>
> {
  const session = await getSessionProfile();
  if (session?.profile?.role !== "admin") {
    return fail("Only an administrator can read classification statistics.");
  }

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const supabase = await createClient();
  // RLS scopes this to the caller's own org, so an admin sees their own
  // organisation's classification mix and nobody else's.
  const { data, error } = await supabase
    .from("tickets")
    .select("classified_by")
    .gte("created_at", since)
    .not("classified_by", "is", null);

  if (error) return fail("Could not read classification statistics.");

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = (row.classified_by as string) ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return ok({
    mix: Array.from(counts, ([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count),
    since,
  });
}
