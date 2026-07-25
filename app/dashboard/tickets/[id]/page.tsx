import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
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
import AcknowledgeControl from "./AcknowledgeControl";
import { shortRef } from "@/lib/acknowledgement";

type AssignableTicket = Ticket & {
  assigned_vendor_id: string | null;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  acknowledged_at: string | null;
};

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

  const canManage =
    session.profile?.role === "admin" ||
    session.profile?.role === "facility_manager";

  const supabase = await createClient();
  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at, assigned_vendor_id, assigned_to_user_id, assigned_at, acknowledged_at"
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

  // Resolve the assigned vendor's name from whichever source the viewer can see:
  // the full vendor list (admin/FM) or the viewer's own vendor record (the vendor).
  const assignedVendorName =
    vendors.find((v) => v.id === t.assigned_vendor_id)?.label ??
    myVendors.find((v) => v.id === t.assigned_vendor_id)?.name ??
    null;

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

      {needsAck && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Acknowledge this job</CardTitle>
          </CardHeader>
          <CardContent>
            <AcknowledgeControl ticketId={t.id} />
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dispatch &amp; status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <AssignControl
              ticketId={t.id}
              vendors={vendors}
              opsStaff={opsStaff}
              currentVendorId={t.assigned_vendor_id}
              currentOpsUserId={t.assigned_to_user_id}
            />
            <Separator />
            <TicketStatusControl ticketId={t.id} currentStatus={t.status} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
