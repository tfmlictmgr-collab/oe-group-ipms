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
  CHAIN_STAGES,
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
 * today — is buried.
 *
 * Rows they cannot action appear under "Waiting on someone else", because
 * knowing a payment is moving is different from being able to move it — but
 * only for someone who is IN THE CHAIN (board, 22 Aug 2026). A person who
 * appears at no stage has no reason to watch other people's payments queue up,
 * and showing them the whole outbound pipeline is a disclosure nobody asked
 * for. Finance is included despite holding no stage: they disburse what the
 * chain clears (decision 16), so what is climbing toward them is their work.
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

  // ⚠️ Resolved in PARALLEL, and the difference is not cosmetic. Each
  // `getChainState` is three round trips, and these were three sequential `for`
  // loops over three hundred rows — up to nine hundred queries end to end on a
  // `force-dynamic` page, which at any realistic latency is past the function's
  // time budget before it renders a single card. The per-row states are wholly
  // independent of each other, so there was never a reason to await them in
  // turn.
  const described = await Promise.all([
    ...(payments ?? []).map(async (p) => {
      const state = await getChainState(supabase, "vendor_payment", p.id);
      const vendor = (p.vendors as { name?: string } | null)?.name ?? "Vendor";
      return {
        payableType: "vendor_payment" as const,
        payableId: p.id,
        title: `${vendor} — ${formatNaira(state.amount)}`,
        subtitle: p.invoice_reference
          ? `Invoice ${p.invoice_reference}`
          : "Vendor invoice",
        href: `/dashboard/payments/${p.id}`,
        state,
      };
    }),
    ...(payouts ?? []).map(async (r) => {
      const state = await getChainState(supabase, "landlord_payout", r.id);
      const prop = (r.properties as { name?: string } | null)?.name ?? "Property";
      return {
        payableType: "landlord_payout" as const,
        payableId: r.id,
        title: `${prop} — ${formatNaira(state.amount)}`,
        subtitle: `Landlord payout${r.period ? ` · ${r.period}` : ""}`,
        href: "/dashboard/ledger/payouts",
        state,
      };
    }),
    ...(requisitions ?? []).map(async (q) => {
      const state = await getChainState(supabase, "ops_requisition", q.id);
      const job = (q.tickets as { summary?: string } | null)?.summary;
      return {
        payableType: "ops_requisition" as const,
        payableId: q.id,
        title: `${q.reference} — ${formatNaira(state.amount)}`,
        subtitle: job ? `Requisition for: ${job}` : "Standalone requisition",
        href: `/dashboard/approvals/requisitions/${q.id}`,
        state,
      };
    }),
  ]);

  // Anything already cleared or refused is not waiting on anybody.
  const rows: QueueRow[] = described.filter(
    (r) => !r.state.clearedForDisbursement && !r.state.rejected
  );

  const mine = rows.filter((r) => canActorAction(actor, r.state));

  // Every role named at any stage, read from CHAIN_STAGES rather than retyped —
  // so a role added to a stage reaches this automatically and cannot be
  // forgotten here. Plus finance, who releases what the chain clears.
  const chainRoles = new Set<string>([
    ...CHAIN_STAGES.flatMap((st) => st.requiredRoles as readonly string[]),
    "finance_approver",
  ]);
  const inChain = chainRoles.has(role);

  // Visible to the chain, actionable only by whoever owns the CURRENT stage —
  // `canActorAction` above is the second half of that and is unchanged.
  const others = inChain
    ? rows.filter((r) => !canActorAction(actor, r.state))
    : [];

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
