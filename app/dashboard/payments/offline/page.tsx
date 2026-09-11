import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, Plus } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import OfflineClaimList, { type QueueRow } from "./OfflineClaimList";

// Payments made off-platform — the shared queue.
//
// One page for three audiences, because they are looking at the same rows for
// overlapping reasons and a second screen would be a second copy of the list:
//
//   • the three confirmation desks, who action what is at their stage
//   • an FM/PM/regional manager, who sees what has been reported on the
//     buildings they hold
//   • whoever recorded one, tracking it
//
// ⚠️ The page applies NO filter of its own. `offline_claim_queue()` is SECURITY
// INVOKER, so `offline_payment_claims_select` decides which rows come back, and
// `is_my_turn` — computed in the query from the caller's own role — decides what
// is actionable. A page that re-derived either would be a second statement of a
// rule the database already owns, which is decision 8's whole subject.

export const dynamic = "force-dynamic";

export default async function OfflinePaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { view } = await searchParams;

  const supabase = await createClient();
  const [{ data }, { data: canRecord }] = await Promise.all([
    supabase.rpc("offline_claim_queue"),
    // Asked of the matrix rather than derived from the role, so an operator who
    // withdraws it from a role sees the button go with it (decision 7).
    supabase.rpc("has_permission", { p_capability: "payments.record_offline" }),
  ]);
  const rows = (data ?? []) as QueueRow[];
  const mine = rows.filter((r) => r.is_my_turn);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Off-platform payments"
        description={
          rows.length === 0
            ? "Payments reported as paid by bank transfer or over a bank counter appear here."
            : mine.length > 0
              ? `${mine.length} waiting for you, of ${rows.length} recorded.`
              : `${rows.length} recorded. Nothing is waiting at your desk.`
        }
        actions={
          canRecord ? (
            <Button asChild size="sm">
              <Link href="/dashboard/payments/offline/new">
                <Plus className="size-4" />
                Record a payment
              </Link>
            </Button>
          ) : null
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Landmark className="size-6" />}
          title="Nothing reported yet"
          description={
            canRecord
              ? "When a tenant pays by transfer or at the bank, record it here with their proof of payment. It reaches the ledger once the audit, executive and Payment Officer desks have each confirmed it."
              : "When someone reports a payment made outside the portal, it will appear here for confirmation."
          }
          action={
            canRecord ? (
              <Button asChild size="sm">
                <Link href="/dashboard/payments/offline/new">Record a payment</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <OfflineClaimList rows={rows} initialView={view === "all" ? "all" : "desk"} />
      )}
    </div>
  );
}
