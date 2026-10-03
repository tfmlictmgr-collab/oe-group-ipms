import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, ReceiptText } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { payableRef } from "@/lib/acknowledgement";
import { getChainState, waitingOn, formatNaira } from "@/lib/approvals/chain";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";

// The requisitions a person raised, and where each one is (requested 3 Oct 2026).
//
// ⚠️ Raising one landed the raiser on its page and then nothing led back to it.
// The approvals queue lists what a person can ACT on — a raiser outside the
// chain (ops staff, an OEA facilities manager) saw an empty queue — and there
// was no list of requisitions at all. So the only route back to "is my
// diesel top-up approved yet?" was the notification, if it arrived.
//
// `raised_by = me` is stated, not trusted: `ops_requisitions_select` admits the
// raiser already, and also admits managers and the chain to rows they did not
// raise. This page is "mine", so it says so in the query.

export const dynamic = "force-dynamic";

/** Enough history to be useful without resolving the chain for every row ever. */
const LIMIT = 50;

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
  });

export default async function MyRequisitionsPage() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const supabase = await createClient();
  const [{ data: rows }, { data: mayRaise }] = await Promise.all([
    supabase
      .from("ops_requisitions")
      .select("id, reference, description, total_amount, status, created_at")
      .eq("raised_by", session.profile.id)
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    supabase.rpc("has_permission", { p_capability: "requisitions.raise" }),
  ]);

  const list = (rows ?? []) as {
    id: string;
    reference: string;
    description: string | null;
    total_amount: number | string;
    status: string;
    created_at: string;
  }[];

  // Where each open one is waiting. Settled and refused ones need no chain read.
  const waiting = new Map<string, string>();
  await Promise.all(
    list
      .filter((r) => ["pending_approval", "returned_for_correction", "approved"].includes(r.status))
      .map(async (r) => {
        const state = await getChainState(supabase, "ops_requisition", r.id);
        waiting.set(
          r.id,
          state.returnedToRaiser
            ? "Sent back to you for correction — open it to fix and resend."
            : state.clearedForDisbursement
              ? "Approved — waiting on the payment officer to send it."
              : waitingOn(state)
        );
      })
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Requisitions"
        description="Requisitions you have raised, newest first, and who each one is waiting on."
        actions={
          mayRaise ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/requisitions/new">
                <ReceiptText /> Raise a requisition
              </Link>
            </Button>
          ) : undefined
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title="You have not raised a requisition yet"
          description="When you raise one it appears here, with where it is in the approval chain."
        />
      ) : (
        <ul className="space-y-2.5">
          {list.map((r) => (
            <li key={r.id}>
              <Link
                href={`/dashboard/approvals/requisitions/${r.id}`}
                className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-medium">
                    {r.reference} — {formatNaira(Number(r.total_amount))}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {payableRef("ops_requisition", r.id)} · raised {fmtDate(r.created_at)}
                    {r.description ? ` · ${r.description.slice(0, 80)}` : ""}
                  </p>
                  {waiting.has(r.id) && (
                    <p className="text-xs font-medium text-foreground">{waiting.get(r.id)}</p>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <StatusBadge status={r.status} />
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.length === LIMIT && (
        <p className="text-xs text-muted-foreground">Showing your {LIMIT} most recent.</p>
      )}
    </div>
  );
}
