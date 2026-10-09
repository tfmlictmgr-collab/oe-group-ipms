import Link from "next/link";
import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { payableRef } from "@/lib/acknowledgement";
import { getChainState, waitingOn, formatNaira } from "@/lib/approvals/chain";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import RequisitionList, { type RequisitionRow } from "./RequisitionList";

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
const LIMIT = 200;

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

  const rowsForList: RequisitionRow[] = list.map((r) => ({
    id: r.id,
    reference: r.reference,
    ref: payableRef("ops_requisition", r.id),
    description: r.description,
    totalAmount: Number(r.total_amount),
    amountLabel: formatNaira(Number(r.total_amount)),
    status: r.status,
    createdAt: r.created_at,
    createdLabel: fmtDate(r.created_at),
    waiting: waiting.get(r.id) ?? null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Requisitions"
        description="Requisitions you have raised and who each one is waiting on. Search, filter by status or date, and sort."
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

      <RequisitionList rows={rowsForList} />

      {list.length === LIMIT && (
        <p className="text-xs text-muted-foreground">
          Showing your {LIMIT} most recent requisitions. Search and filters apply to these.
        </p>
      )}
    </div>
  );
}
