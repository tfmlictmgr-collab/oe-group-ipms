import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CircleAlert, Paperclip } from "lucide-react";
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
      "id, org_id, reference, total_amount, status, raised_by, created_at, rejected_reason, invoice_attachment_path, tickets(id, summary, category, urgency, property_or_unit), users!ops_requisitions_raised_by_fkey(full_name)"
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

  // ⚠️ The evidence the chain is being asked to approve AGAINST.
  //
  // `raise_ops_requisition` has accepted an attachment since 0170 and the
  // FM/PM form has uploaded one since — into the same bucket a vendor invoice
  // scan uses. 0140's read policy on that bucket joined `payments` and nothing
  // else, so a requisition's invoice was unreadable by every role, and this
  // page selected the column and never rendered it. Both halves are fixed:
  // 0217 for the policy, this for the screen.
  //
  // The path never came from the client — it is read off a row RLS already
  // admitted — so signing it here needs no second authorisation check.
  let invoiceUrl: string | null = null;
  if (req.invoice_attachment_path) {
    const { data: signed } = await supabase.storage
      .from("invoice-attachments")
      .createSignedUrl(req.invoice_attachment_path, 300);
    invoiceUrl = signed?.signedUrl ?? null;
  }
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(req.invoice_attachment_path ?? "");

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

  const ticket = req.tickets as unknown as {
    id: string;
    summary: string | null;
    category: string | null;
    urgency: string | null;
    property_or_unit: string | null;
  } | null;
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

      {/* Everything the chain needs in order to judge this, on the page they
          land on — the invoice, the job it was raised against, and who raised
          it when. The auditor's stage exists to check an invoice AGAINST the
          job card and the evidence; before this they had neither on screen. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The requisition as raised</CardTitle>
          <CardDescription>
            {formatNaira(req.total_amount)} · raised by {raiser ?? "someone no longer listed"}
            {req.created_at
              ? ` on ${new Date(req.created_at).toLocaleDateString("en-NG", {
                  day: "numeric", month: "long", year: "numeric",
                })}`
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ticket ? (
            <div className="space-y-1 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">Raised for this job</p>
              <Link
                href={`/dashboard/tickets/${ticket.id}`}
                className="text-sm font-medium hover:underline"
              >
                {ticket.summary ?? "Service request"}
              </Link>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {ticket.category && <Badge variant="outline" className="text-[10px]">{ticket.category}</Badge>}
                {ticket.urgency && <Badge variant="muted" className="text-[10px]">{ticket.urgency}</Badge>}
                {ticket.property_or_unit && (
                  <Badge variant="muted" className="text-[10px]">{ticket.property_or_unit}</Badge>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Standalone — not raised against a specific job.
            </p>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Invoice / quotation</p>
            {invoiceUrl ? (
              <div className="space-y-2">
                {isImage && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={invoiceUrl}
                    alt="The invoice attached to this requisition"
                    className="max-h-96 w-auto rounded-md border border-border"
                  />
                )}
                <Button asChild variant="outline" size="sm" className="w-fit">
                  <a href={invoiceUrl} target="_blank" rel="noopener noreferrer">
                    <Paperclip /> Open the attached invoice
                  </a>
                </Button>
              </div>
            ) : req.invoice_attachment_path ? (
              // The path is on the row but storage would not sign it. Said
              // plainly rather than rendered as an absence — "no invoice" and
              // "an invoice you cannot open" need different actions.
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <CircleAlert className="size-4" />
                An invoice is attached but could not be opened. Tell whoever raised it.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing was attached when this was raised.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

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
