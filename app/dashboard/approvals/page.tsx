import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import StageActions from "@/components/approvals/StageActions";
import {
  getChainState, canActorAction, whyNotActionable, formatNaira, effectiveTier,
  tierLabel, type PayableType, type ChainState, type StageOrder,
} from "@/lib/approvals/chain";

export const dynamic = "force-dynamic";

type QueueRow = {
  payableType: PayableType;
  payableId: string;
  title: string;
  subtitle: string;
  href: string | null;
  state: ChainState;
};

/**
 * The outbound-payment approval queue.
 *
 * ⚠️ Scoped by what the viewer can ACTUALLY ACTION, not by what exists. A tier-1
 * approver shown a queue of ₦5m payments they cannot clear learns only that the
 * screen is lying to them, and the useful signal — the three they can action
 * today — is buried. Rows they cannot action still appear under "Waiting on
 * someone else", because knowing a payment is moving is different from being
 * able to move it.
 */
export default async function ApprovalsPage() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const role = session.profile.role;
  const supabase = await createClient();

  const { data: me } = await supabase
    .from("users").select("id, role, approval_tier").eq("id", session.profile.id).single();

  const actor = {
    id: me?.id ?? session.profile.id,
    role: me?.role ?? role,
    approvalTier: me?.approval_tier ?? null,
  };
  const myTier = effectiveTier(actor.role, actor.approvalTier);

  // Vendor invoices that have passed the B4 gate, landlord payouts raised and
  // not yet sent, and FM/PM ops requisitions awaiting the same chain (0170).
  const [{ data: payments }, { data: payouts }, { data: requisitions }] = await Promise.all([
    supabase
      .from("payments")
      .select("id, amount, invoice_reference, status, vendors(name)")
      .in("status", ["recommended", "approved"])
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("remittances")
      .select("id, net_amount, period, reference, status, properties(name)")
      .eq("party", "landlord")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("ops_requisitions")
      .select("id, total_amount, reference, status, tickets(summary)")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  const rows: QueueRow[] = [];

  for (const p of payments ?? []) {
    const state = await getChainState(supabase, "vendor_payment", p.id);
    if (state.clearedForDisbursement || state.rejected) continue;
    const vendor = (p.vendors as { name?: string } | null)?.name ?? "Vendor";
    rows.push({
      payableType: "vendor_payment",
      payableId: p.id,
      title: `${vendor} — ${formatNaira(state.amount)}`,
      subtitle: p.invoice_reference
        ? `Invoice ${p.invoice_reference}`
        : "Vendor invoice",
      href: `/dashboard/payments/${p.id}`,
      state,
    });
  }

  for (const r of payouts ?? []) {
    const state = await getChainState(supabase, "landlord_payout", r.id);
    if (state.clearedForDisbursement || state.rejected) continue;
    const prop = (r.properties as { name?: string } | null)?.name ?? "Property";
    rows.push({
      payableType: "landlord_payout",
      payableId: r.id,
      title: `${prop} — ${formatNaira(state.amount)}`,
      subtitle: `Landlord payout${r.period ? ` · ${r.period}` : ""}`,
      href: "/dashboard/ledger/payouts",
      state,
    });
  }

  for (const q of requisitions ?? []) {
    const state = await getChainState(supabase, "ops_requisition", q.id);
    if (state.clearedForDisbursement || state.rejected) continue;
    const job = (q.tickets as { summary?: string } | null)?.summary;
    rows.push({
      payableType: "ops_requisition",
      payableId: q.id,
      title: `${q.reference} — ${formatNaira(state.amount)}`,
      subtitle: job ? `Requisition for: ${job}` : "Standalone requisition",
      href: `/dashboard/approvals/requisitions/${q.id}`,
      state,
    });
  }

  const mine = rows.filter((r) => canActorAction(actor, r.state));
  const others = rows.filter((r) => !canActorAction(actor, r.state));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Every payment leaving the organisation — vendor invoices, landlord
          payouts and ops requisitions alike — passes three pairs of hands
          before finance sends it.
          {myTier ? ` You approve up to ${tierLabel(myTier).toLowerCase()}.` : ""}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Waiting on you ({mine.length})
        </h2>
        {mine.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nothing is waiting on you right now.
            </CardContent>
          </Card>
        ) : (
          mine.map((r) => (
            <Card key={`${r.payableType}:${r.payableId}`}>
              <CardHeader>
                <CardTitle className="text-base">
                  {r.href ? (
                    <Link href={r.href} className="hover:underline">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </CardTitle>
                <CardDescription>{r.subtitle}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ChainTrail state={r.state} />
                {r.state.nextStage && (
                  <StageActions
                    payableType={r.payableType}
                    payableId={r.payableId}
                    stage={r.state.nextStage.stageOrder as StageOrder}
                    stageLabel={r.state.nextStage.short}
                  />
                )}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {others.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Waiting on someone else ({others.length})
          </h2>
          {others.map((r) => (
            <Card key={`${r.payableType}:${r.payableId}`} className="opacity-80">
              <CardHeader>
                <CardTitle className="text-base">
                  {r.href ? (
                    <Link href={r.href} className="hover:underline">
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </CardTitle>
                <CardDescription>
                  {r.subtitle} · {whyNotActionable(actor, r.state)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChainTrail state={r.state} />
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
