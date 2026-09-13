import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CircleAlert, Paperclip } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import StageActions from "@/components/approvals/StageActions";
import ResubmitPanel from "@/components/approvals/ResubmitPanel";
import { getChainState, canActorAction, formatNaira } from "@/lib/approvals/chain";
import LinePayeeForm from "./LinePayeeForm";
import SendLineGroup from "./SendLineGroup";
import BankTransferAccount from "@/components/payouts/BankTransferAccount";

export const dynamic = "force-dynamic";

type Line = {
  id: string;
  description: string;
  amount: number;
  vendor_id: string | null;
  payee_recipient_id: string | null;
  remittance_id: string | null;
  /** A payee asked for their bank details who has not answered yet (0289). */
  payout_request_id: string | null;
  vendors: { id: string; name: string } | null;
  payout_recipients: { id: string; display_name: string; gateway: string } | null;
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
      "id, org_id, reference, total_amount, requested_amount, status, raised_by, created_at, rejected_reason, invoice_attachment_path, tickets(id, summary, category, urgency, property_or_unit), users!ops_requisitions_raised_by_fkey(full_name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!req) notFound();

  const { data: linesData } = await supabase
    .from("ops_requisition_lines")
    .select(
      "id, description, amount, vendor_id, payee_recipient_id, remittance_id, payout_request_id, vendors(id, name), payout_recipients(id, display_name, gateway)"
    )
    .eq("requisition_id", id)
    .order("line_order");
  const lines = (linesData ?? []) as unknown as Line[];

  // Payees asked for their bank details — the name the approvers see, and the
  // link's state. Read through the caller's session: `payout_detail_requests`
  // is readable by anyone who can already see this requisition (0289).
  const askedLineIds = lines.filter((l) => l.payout_request_id).map((l) => l.id);
  const { data: askedRows } = askedLineIds.length
    ? await supabase
        .from("payout_detail_requests")
        .select("id, requisition_line_id, payee_name, requested_at, expires_at, contact_email, contact_phone, submitted_at, withdrawn_at")
        .in("requisition_line_id", askedLineIds)
        .order("requested_at", { ascending: false })
    : { data: [] };
  const waiting = new Map<string, { payeeName: string; request: { id: string; sentAt: string; expiresAt: string; lapsed: boolean; to: string } | null }>();
  for (const q of askedRows ?? []) {
    if (waiting.has(q.requisition_line_id)) continue;   // newest first
    const live = !q.submitted_at && !q.withdrawn_at;
    waiting.set(q.requisition_line_id, {
      payeeName: q.payee_name,
      request: live
        ? {
            id: q.id,
            sentAt: q.requested_at,
            expiresAt: q.expires_at,
            lapsed: new Date(q.expires_at).getTime() < Date.now(),
            to: [q.contact_email, q.contact_phone].filter(Boolean).join(" and "),
          }
        : null,
    });
  }

  const { orgGatewayUsable } = await import("@/lib/payout-views");
  const gatewayUsable = await orgGatewayUsable(req.org_id);

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
  const canManagePayouts = ["admin", "finance_approver"].includes(actor.role);
  // Who can open a remittance advice — `remittances_select`'s own list. The
  // raiser cannot, so the "Settled" badge is a link only for those who can.
  const seesRemittances = ["admin", "finance_approver", "executive", "payment_approver", "payment_audit_approver"].includes(actor.role);

  // Group unsettled lines by distinct payee — one remittance per group,
  // mirroring how create_requisition_vendor_remittance /
  // create_requisition_payee_remittance settle them (0173).
  const vendorGroups = new Map<string, { name: string; total: number }>();
  const payeeGroups = new Map<string, { name: string; total: number; gateway: string }>();
  const unassigned: Line[] = [];

  for (const l of lines) {
    if (l.remittance_id) continue;
    if (l.vendor_id && l.vendors) {
      const g = vendorGroups.get(l.vendor_id) ?? { name: l.vendors.name, total: 0 };
      g.total += Number(l.amount);
      vendorGroups.set(l.vendor_id, g);
    } else if (l.payee_recipient_id && l.payout_recipients) {
      const g = payeeGroups.get(l.payee_recipient_id) ?? {
        name: l.payout_recipients.display_name, total: 0, gateway: l.payout_recipients.gateway,
      };
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
    // ⚠️ `printable` is what makes this sheet legible on paper (globals.css):
    // the nav goes, every button goes — including the approve/refuse controls,
    // which cannot be clicked in ink — and the card tints that carry meaning
    // survive. Asked for as "print approvals made by an approver at any stage
    // for physical filing", and the thing worth filing is this page: the
    // reference, the amount, the lines, and every decision with its author and
    // its timestamp.
    <div className="printable mx-auto max-w-3xl space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Approvals"}
        title="Requisition approval record"
        subtitle={`${req.reference} · ${formatNaira(req.total_amount)}`}
        by={session.profile?.full_name || session.profile?.email || undefined}
      />

      <div data-print="screen-only">
        <PageHeader
          title="Requisition"
          description={`${req.reference} · raised by ${raiser ?? "someone no longer listed"}${ticket ? ` · for ${ticket.summary ?? "a job"}` : ""}`}
          actions={
            <div className="flex items-center gap-2">
              <PrintButton label="Print for filing" />
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/approvals"><ArrowLeft /> Back to Approvals</Link>
              </Button>
            </div>
          }
        />
      </div>

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
            {formatNaira(req.total_amount)}
            {req.requested_amount != null &&
              Number(req.requested_amount) !== Number(req.total_amount) && (
                // 0270. Both figures, because one of them is a decision
                // somebody made and the other is what was asked for. Until
                // now the revision lived in a comment ("MP approve 150,000")
                // and the header went on showing the claim.
                <>
                  {" "}
                  <span className="text-muted-foreground">
                    (approved, down from {formatNaira(req.requested_amount)})
                  </span>
                </>
              )}{" "}
            · raised by {raiser ?? "someone no longer listed"}
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
                  seesRemittances ? (
                    <Link href={`/dashboard/remittances/${l.remittance_id}`}>
                      <Badge variant="success">Settled — remittance advice</Badge>
                    </Link>
                  ) : (
                    <Badge variant="success">Settled</Badge>
                  )
                ) : l.vendor_id ? (
                  <Badge variant="outline">Vendor: {l.vendors?.name ?? "—"}</Badge>
                ) : l.payee_recipient_id ? (
                  <Badge variant="outline">
                    Payee: {l.payout_recipients?.display_name ?? "—"}
                    {l.payout_recipients?.gateway === "manual" ? " · by bank transfer" : ""}
                  </Badge>
                ) : l.payout_request_id ? (
                  <Badge variant="info">
                    Waiting for {waiting.get(l.id)?.payeeName ?? "the payee"}&apos;s bank details
                  </Badge>
                ) : (
                  <Badge variant="muted">Recorded only — no payee</Badge>
                )}
              </div>
              {/* A payee with no registered vendor record: either verified at
                  the bank through Paystack (when this organisation has its own
                  account), or asked for their details by a secure link and paid
                  by bank transfer (0289). The name is fixed before approval;
                  the details may arrive after it. */}
              {!l.vendor_id && !l.payee_recipient_id && !l.remittance_id &&
                (l.payout_request_id || req.status === "pending_approval") && (
                <div className="space-y-3">
                  {!l.payout_request_id && req.status === "pending_approval" && gatewayUsable && (
                    <LinePayeeForm lineId={l.id} defaultName={raiser ?? ""} />
                  )}
                  <BankTransferAccount
                    party="other"
                    lineId={l.id}
                    payeeName={waiting.get(l.id)?.payeeName ?? ""}
                    purpose={`${req.reference ?? "a requisition"} — ${l.description}`}
                    account={null}
                    request={waiting.get(l.id)?.request ?? null}
                    canManage={canManagePayouts}
                    askForName={!l.payout_request_id}
                    path={`/dashboard/approvals/requisitions/${req.id}`}
                  />
                </div>
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

          {/* Sent all the way back to the raiser (0250b). Rendered for anyone
              who can see the requisition; `resubmit_returned_payable` decides
              who may actually act, and a panel that explains why it is sitting
              here is worth showing to the auditor waiting on it too. */}
          {req.status === "returned_for_correction" && (
            <ResubmitPanel
              payableType="ops_requisition"
              payableId={req.id}
              returnedReason={state.returnedReason}
              returnedBy={state.returnedBy}
            />
          )}

          {canAction && state.nextStage && (
            <StageActions
              payableType="ops_requisition"
              payableId={req.id}
              stage={state.nextStage.stageOrder}
              stageLabel={state.nextStage.short}
              verb={state.nextStage.verb}
              amount={state.amount}
              returnsTo={
                state.nextStage.stageOrder === 1
                  ? (raiser ?? "whoever raised it")
                  : (state.stages.find(
                      (s) => s.stageOrder === state.nextStage!.stageOrder - 1
                    )?.short ?? "the desk below")
              }
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
                orgId={req.org_id} allowGateway={gatewayUsable}
              />
            ))}
            {Array.from(payeeGroups.entries()).map(([payeeId, g]) => (
              <SendLineGroup
                key={payeeId} requisitionId={req.id} kind="payee" targetId={payeeId}
                name={g.name} amount={g.total}
                orgId={req.org_id}
                // A one-off payee's account IS their identity, so it is paid
                // the way it was set up: a gateway recipient through Paystack,
                // an evidenced account by bank transfer.
                allowGateway={gatewayUsable && g.gateway !== "manual"}
                allowBankTransfer={g.gateway === "manual"}
              />
            ))}
            {lines.some((l) => !l.remittance_id && l.payout_request_id && !l.payee_recipient_id) && (
              <p className="text-xs text-muted-foreground">
                Lines still waiting for the payee&apos;s bank details are not listed here — they appear
                once the payee has answered.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
