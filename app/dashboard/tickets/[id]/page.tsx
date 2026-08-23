import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, ReceiptText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { type Ticket, CHANNEL_LABELS, formatDateTime } from "@/lib/ticket-format";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import TicketStatusControl from "./TicketStatusControl";
import AssignControl from "./AssignControl";
import ReviewControl from "./ReviewControl";
import AcknowledgeControl from "./AcknowledgeControl";
import VendorJobActions from "./VendorJobActions";
import EvaluationChecklist, { type ChecklistCriterion } from "./EvaluationChecklist";
import TicketMedia, { type TicketAttachment } from "./TicketMedia";
import { ChatWithUs } from "@/components/patterns/chat-with-us";
import { shortRef } from "@/lib/acknowledgement";
import { FM_PM } from "@/lib/roles";

type AssignableTicket = Ticket & {
  assigned_vendor_id: string | null;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  acknowledged_at: string | null;
  reviewed_at: string | null;
  sender_id: string | null;
};

const DONE_STATES = ["resolved", "closed"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Dispatch authority: who may ASSIGN a job and later EVALUATE the vendor.
  // `regional_manager` was missing here — B7 gives them the same operational
  // authority as a facility/properties manager over a wider place (0078a's
  // `fm_roles()`), and `tickets.assign` is granted to both in the permission
  // matrix (0072b). `fm_ops_staff` deliberately stays OUT of this one: they
  // hold no `tickets.assign` capability, `AssignControl` has no guard of its
  // own, and `assignTicket` has no server-side role check either — it relies
  // entirely on RLS to refuse. Bundling them in here would have shown a
  // dispatch control the database was always going to reject.
  const canManage =
    session.profile?.role === "admin" ||
    (FM_PM as readonly string[]).includes(session.profile?.role ?? "") ||
    session.profile?.role === "regional_manager";

  const supabase = await createClient();
  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at, assigned_vendor_id, assigned_to_user_id, assigned_at, acknowledged_at, reviewed_at, sender_id"
    )
    .eq("id", id)
    .single();

  if (!ticket) notFound();
  const t = ticket as AssignableTicket;

  // For the dispatch control (admin/FM): available vendors + ops staff.
  const [vendorsRes, opsRes, myVendorRes] = await Promise.all([
    canManage
      ? supabase.from("vendors").select("id, name").order("name")
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    canManage
      ? supabase
          .from("users")
          .select("id, full_name, email")
          .eq("role", "fm_ops_staff")
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string | null }[] }),
    supabase.from("vendors").select("id, name").eq("user_id", session.user.id),
  ]);

  const vendors = (vendorsRes.data ?? []).map((v) => ({ id: v.id, label: v.name }));
  const opsStaff = (opsRes.data ?? []).map((o) => ({
    id: o.id,
    label: o.full_name ?? o.email ?? "Ops staff",
  }));

  // Is the current viewer the assignee (and the job still needs acknowledging)?
  const myVendors = (myVendorRes.data ?? []) as { id: string; name: string }[];
  const myVendorIds = myVendors.map((v) => v.id);
  const isAssignee =
    t.assigned_to_user_id === session.user.id ||
    (t.assigned_vendor_id != null && myVendorIds.includes(t.assigned_vendor_id));
  const needsAck = t.status === "assigned" && isAssignee;
  // A contractor's own controls: accept, decline, mark complete. Shown when
  // the job is assigned to THEIR vendor company — an ops-staff assignee keeps
  // the simpler acknowledge card, since decline/complete are the contractor's
  // relationship with the work order, not an internal staff transition.
  const isVendorAssignee =
    t.assigned_vendor_id != null && myVendorIds.includes(t.assigned_vendor_id);

  // Resolve the assigned vendor's name from whichever source the viewer can see:
  // the full vendor list (admin/FM) or the viewer's own vendor record (the vendor).
  const assignedVendorName =
    vendors.find((v) => v.id === t.assigned_vendor_id)?.label ??
    myVendors.find((v) => v.id === t.assigned_vendor_id)?.name ??
    null;

  // ── Evaluation: only meaningful once the job is actually done, and only
  // fetched for someone who could conceivably submit one — the same person
  // this page would show a checklist to below. Everyone else pays no query for
  // a section they will never see.
  const isTenant = Boolean(t.sender_id) && t.sender_id === session.user.id;
  const isDone = DONE_STATES.includes(t.status);
  const canEvaluate = t.assigned_vendor_id != null && isDone && (isTenant || canManage);

  // ⚠️ THE ACTUAL BUG. `assigned_to_user_id = auth.uid()` has been in
  // `tickets_update`'s RLS policy since the table existed — the database
  // always let a dispatched ops staff member move their own job's status. The
  // UI never rendered the control for them: this card gated on `canManage`
  // alone, which was dispatch authority, and status-on-your-own-job is a
  // narrower, different permission. An ops staff member could Acknowledge (its
  // own separate card) and then had no way to record progress or mark a job
  // done — the empty middle of "My jobs → acknowledge → [nothing] → evidence".
  const canExecuteStatus = canManage || (session.profile?.role === "fm_ops_staff" && isAssignee);

  const [criteriaRes, evalsRes] = canEvaluate
    ? await Promise.all([
        supabase
          .from("evaluation_criteria")
          .select("id, dimension, label, response_type, max_points")
          .eq("active", true).eq("measure", "manual")
          .in("dimension", isTenant ? ["satisfaction"] : ["quality", "compliance"])
          .order("sort_order"),
        supabase
          .from("vendor_evaluations")
          .select("source")
          .eq("ticket_id", t.id),
      ])
    : [{ data: [] as ChecklistCriterion[] }, { data: [] as { source: string }[] }];

  const alreadySubmitted = new Set((evalsRes.data ?? []).map((e) => e.source));
  const tenantDone = alreadySubmitted.has("tenant");
  const fmDone = alreadySubmitted.has("fm_pm");

  // ── Evidence (0106). The rows are gated by the attachment policy, which
  // defers to this ticket's own visibility — so anyone reading this page is
  // by definition entitled to what comes back, and no extra check is needed
  // here. Uploading additionally requires the job to still be open.
  const { data: attachmentRows } = await supabase
    .from("ticket_attachments")
    .select("id, storage_path, file_name, content_type, size_bytes, uploaded_by, uploaded_at")
    .eq("ticket_id", t.id)
    .order("uploaded_at", { ascending: false });

  const rows = attachmentRows ?? [];

  // The bucket is private, so a thumbnail needs a signed URL. Signed in one
  // batch rather than one call per file, and for an hour rather than the
  // five minutes an open-in-new-tab link gets — a page left open while
  // someone works through the evidence should not quietly go blank.
  const signed = rows.length
    ? (
        await supabase.storage
          .from("work-order-media")
          .createSignedUrls(rows.map((r) => r.storage_path), 3600)
      ).data ?? []
    : [];
  const urlFor = new Map(signed.map((s) => [s.path, s.signedUrl] as const));

  // Uploader names, best-effort: a tenant has no read on the staff register,
  // and an unattributed thumbnail is a smaller loss than a failed page.
  const uploaderIds = Array.from(new Set(rows.map((r) => r.uploaded_by)));
  const { data: uploaders } = uploaderIds.length
    ? await supabase.from("users").select("id, full_name, email").in("id", uploaderIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const nameFor = new Map(
    (uploaders ?? []).map((u) => [u.id, u.full_name ?? u.email ?? null] as const)
  );

  const attachments: TicketAttachment[] = rows.map((r) => ({
    ...r,
    url: urlFor.get(r.storage_path) ?? null,
    uploader_name: nameFor.get(r.uploaded_by) ?? null,
  }));

  const canAttach = !isDone;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t.summary ?? t.message_text}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={t.status} />
            {t.urgency && <StatusBadge status={t.urgency} />}
            {t.category && (
              <Badge variant="outline" className="capitalize">
                {t.category}
              </Badge>
            )}
            {t.requires_human_review && <Badge variant="warning">Needs review</Badge>}
          </span>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-5 pt-5">
          <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Reference">
              <span className="font-mono font-semibold">{shortRef(t.id)}</span>
              <span className="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">
                {t.id}
              </span>
            </Field>
            <Field label="Channel">{CHANNEL_LABELS[t.channel] ?? t.channel}</Field>
            <Field label="Property / Unit">{t.property_or_unit ?? "—"}</Field>
            <Field label="Created">{formatDateTime(t.created_at)}</Field>
            <Field label="Assigned to">
              <span className="flex flex-wrap items-center gap-2">
                {assignedVendorName ?? (t.assigned_to_user_id ? "Ops staff" : "—")}
                {t.acknowledged_at && (
                  <Badge variant="success">
                    <CheckCircle2 className="size-3" /> Acknowledged
                  </Badge>
                )}
              </span>
            </Field>
            <Field label="Human review">
              {t.requires_human_review ? "Flagged" : "Not required"}
            </Field>
          </dl>

          <Separator />

          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Original message
            </p>
            <p className="whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-sm">
              {t.message_text}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* A closed request with no evidence has nothing to show and nothing to
          add — the card would be an empty box on every historical ticket. */}
      {(attachments.length > 0 || canAttach) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Photos &amp; video</CardTitle>
          </CardHeader>
          <CardContent>
            <TicketMedia
              ticketId={t.id}
              orgId={session.profile!.org_id}
              currentUserId={session.user.id}
              attachments={attachments}
              canUpload={canAttach}
            />
          </CardContent>
        </Card>
      )}

      {isVendorAssignee && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your job</CardTitle>
          </CardHeader>
          <CardContent>
            <VendorJobActions
              ticketId={t.id}
              orgId={session.profile!.org_id}
              status={t.status}
              acknowledged={Boolean(t.acknowledged_at)}
            />
          </CardContent>
        </Card>
      )}

      {needsAck && !isVendorAssignee && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Acknowledge this job</CardTitle>
          </CardHeader>
          <CardContent>
            <AcknowledgeControl ticketId={t.id} />
          </CardContent>
        </Card>
      )}

      {/*
        Offered to the person who RAISED the request, not to the staff handling
        it — staff are the other end of this conversation, and a "chat with us"
        button on an operator's screen is at best noise. The reference is passed
        so the chat opens already placed, rather than starting with the tenant
        re-explaining which request they mean.
      */}
      {isTenant && !canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Need to talk to us?</CardTitle>
          </CardHeader>
          <CardContent>
            <ChatWithUs theme={session.theme} ticketReference={shortRef(t.id)} size="sm" />
          </CardContent>
        </Card>
      )}

      {canExecuteStatus && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {canManage ? "Dispatch & status" : "Progress"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Assignment stays with dispatch authority only — an ops staff
                member executes the job they were given, they do not hand it
                to someone else. */}
            {canManage && (
              <>
                {/* 0178: an FM/regional_manager reviews before dispatch — a
                    request self-raised via raiseWorkOrder arrives already
                    reviewed, so this only shows for what came from somewhere
                    else (tenant, vendor, WhatsApp, Telegram, the portal). */}
                {!t.reviewed_at && !t.assigned_vendor_id && !t.assigned_to_user_id ? (
                  <ReviewControl ticketId={t.id} />
                ) : (
                  <AssignControl
                    ticketId={t.id}
                    vendors={vendors}
                    opsStaff={opsStaff}
                    currentVendorId={t.assigned_vendor_id}
                    currentOpsUserId={t.assigned_to_user_id}
                  />
                )}
                <Separator />
              </>
            )}
            <TicketStatusControl ticketId={t.id} currentStatus={t.status} />
            <Separator />
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/requisitions/new?ticket=${t.id}`}>
                <ReceiptText /> Raise a requisition for this job
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {canEvaluate && isTenant && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rate this job</CardTitle>
          </CardHeader>
          <CardContent>
            {tenantDone ? (
              <p className="text-sm text-muted-foreground">
                You already rated this job — thank you.
              </p>
            ) : (
              <EvaluationChecklist
                ticketId={t.id}
                source="tenant"
                criteria={(criteriaRes.data as ChecklistCriterion[]) ?? []}
                title="Review"
                description="Your honest answer helps keep the standard of vendors working on your property."
              />
            )}
          </CardContent>
        </Card>
      )}

      {canEvaluate && !isTenant && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Evaluate the vendor</CardTitle>
          </CardHeader>
          <CardContent>
            {fmDone ? (
              <p className="text-sm text-muted-foreground">
                You already evaluated this job. Response and completion time
                were scored automatically against the SLA target; the tenant&apos;s
                satisfaction review completes the vendor&apos;s score for this job
                once they submit it.
              </p>
            ) : (
              <EvaluationChecklist
                ticketId={t.id}
                source="fm_pm"
                criteria={(criteriaRes.data as ChecklistCriterion[]) ?? []}
                title="Evaluation"
                description="Response and completion time are measured automatically from this job's own timestamps — only quality and compliance need your answer."
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
