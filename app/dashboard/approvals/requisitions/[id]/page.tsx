import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import StageActions from "@/components/approvals/StageActions";
import { getChainState, canActorAction, formatNaira } from "@/lib/approvals/chain";
import LinePayeeForm from "./LinePayeeForm";
import SendLineGroup from "./SendLineGroup";

export const dynamic = "force-dynamic";

type Line = {
  id: string;
  description: string;
  amount: number;
  vendor_id: string | null;
  payee_recipient_id: string | null;
  remittance_id: string | null;
  vendors: { id: string; name: string } | null;
  payout_recipients: { id: string; display_name: string } | null;
};

export default async function RequisitionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");

  const supabase = await createClient();
  const { data: req } = await supabase
    .from("ops_requisitions")
    .select(
      "id, org_id, reference, total_amount, status, raised_by, rejected_reason, invoice_attachment_path, tickets(id, summary), users!ops_requisitions_raised_by_fkey(full_name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!req) notFound();

  const { data: linesData } = await supabase
    .from("ops_requisition_lines")
    .select(
      "id, description, amount, vendor_id, payee_recipient_id, remittance_id, vendors(id, name), payout_recipients(id, display_name)"
    )
    .eq("requisition_id", id)
    .order("line_order");
  const lines = (linesData ?? []) as unknown as Line[];

  const { data: me } = await supabase
    .from("users").select("id, role, approval_tier").eq("id", session.profile.id).single();
  const actor = {
    id: me?.id ?? session.profile.id,
    role: me?.role ?? session.profile.role,
    approvalTier: me?.approval_tier ?? null,
  };

  const state = await getChainState(supabase, "ops_requisition", req.id);
  const canAction = canActorAction(actor, state);
  const isFinance = actor.role === "finance_approver";

  // Group unsettled lines by distinct payee — one remittance per group,
  // mirroring how create_requisition_vendor_remittance /
  // create_requisition_payee_remittance settle them (0173).
  const vendorGroups = new Map<string, { name: string; total: number }>();
  const payeeGroups = new Map<string, { name: string; total: number }>();
  const unassigned: Line[] = [];

  for (const l of lines) {
    if (l.remittance_id) continue;
    if (l.vendor_id && l.vendors) {
      const g = vendorGroups.get(l.vendor_id) ?? { name: l.vendors.name, total: 0 };
      g.total += Number(l.amount);
      vendorGroups.set(l.vendor_id, g);
    } else if (l.payee_recipient_id && l.payout_recipients) {
      const g = payeeGroups.get(l.payee_recipient_id) ?? { name: l.payout_recipients.display_name, total: 0 };
      g.total += Number(l.amount);
      payeeGroups.set(l.payee_recipient_id, g);
    } else if (!l.vendor_id) {
      unassigned.push(l);
    }
  }

  const ticket = req.tickets as unknown as { id: string; summary: string | null } | null;
  const raiser = (req.users as unknown as { full_name: string | null } | null)?.full_name;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={req.reference}
        description={`Raised by ${raiser ?? "someone no longer listed"}${ticket ? ` · for ${ticket.summary ?? "a job"}` : ""}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/approvals"><ArrowLeft /> Back to Approvals</Link>
          </Button>
        }
      />

      {req.status === "rejected" && req.rejected_reason && (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm">
            <p className="font-medium text-destructive">Rejected</p>
            <p className="mt-1 text-muted-foreground">{req.rejected_reason}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost lines</CardTitle>
          <CardDescription>{formatNaira(req.total_amount)} total, across {lines.length} line{lines.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {lines.map((l) => (
            <div key={l.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm">{l.description}</p>
                <p className="shrink-0 text-sm font-medium tabular-nums">{formatNaira(l.amount)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {l.remittance_id ? (
                  <Badge variant="success">Settled</Badge>
                ) : l.vendor_id ? (
                  <Badge variant="outline">Vendor: {l.vendors?.name ?? "—"}</Badge>
                ) : l.payee_recipient_id ? (
                  <Badge variant="outline">Payee: {l.payout_recipients?.display_name ?? "—"}</Badge>
                ) : (
                  <Badge variant="muted">Recorded only — no payee</Badge>
                )}
              </div>
              {!l.vendor_id && !l.payee_recipient_id && req.status === "pending_approval" && (
                <LinePayeeForm lineId={l.id} defaultName={raiser ?? ""} />
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Approval chain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChainTrail state={state} />
          {canAction && state.nextStage && (
            <StageActions
              payableType="ops_requisition"
              payableId={req.id}
              stage={state.nextStage.stageOrder}
              stageLabel={state.nextStage.short}
            />
          )}
        </CardContent>
      </Card>

      {isFinance && req.status === "approved" && (vendorGroups.size > 0 || payeeGroups.size > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Send</CardTitle>
            <CardDescription>One transfer per payee, for every settled-nothing-yet line naming them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from(vendorGroups.entries()).map(([vendorId, g]) => (
              <SendLineGroup
                key={vendorId} requisitionId={req.id} kind="vendor" targetId={vendorId}
                name={g.name} amount={g.total}
              />
            ))}
            {Array.from(payeeGroups.entries()).map(([payeeId, g]) => (
              <SendLineGroup
                key={payeeId} requisitionId={req.id} kind="payee" targetId={payeeId}
                name={g.name} amount={g.total}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
