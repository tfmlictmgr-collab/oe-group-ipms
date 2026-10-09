import type { SupabaseClient } from "@supabase/supabase-js";

// Records marked as test data (0321) — kept because money touched them, hidden
// from activity screens unless "Show test records" is chosen, and labelled TEST
// when shown. The ledger's arithmetic (balances, trial balance, fund statements)
// always includes them; only lists of activity hide them.
//
// `test_records` is readable by anyone signed in to the same organisation, so
// this asks the same question on every screen in the reader's own session.

export type TestEntity =
  | "user" | "vendor" | "property" | "lease" | "ticket" | "payment" | "ops_requisition"
  | "payment_intent" | "remittance" | "offline_payment_claim" | "tenant_application" | "ledger_entry";

/** Ids of this organisation's records of one type marked as test. */
export async function testIds(supabase: SupabaseClient, type: TestEntity): Promise<Set<string>> {
  const { data } = await supabase.from("test_records").select("entity_id").eq("entity_type", type).limit(5000);
  return new Set(((data ?? []) as { entity_id: string }[]).map((r) => r.entity_id));
}

/** "Show test records" is on when the page's URL carries ?test=1. */
export function showingTest(params: { test?: string | string[] } | undefined): boolean {
  const v = params?.test;
  return (Array.isArray(v) ? v[0] : v) === "1";
}

/** Keep the rows a reader should see: everything when showing test records, else all but the marked ones. */
export function withoutTest<T>(rows: T[], marked: Set<string>, show: boolean, idOf: (r: T) => string | null | undefined): T[] {
  if (show || marked.size === 0) return rows;
  return rows.filter((r) => {
    const id = idOf(r);
    return !id || !marked.has(id);
  });
}
