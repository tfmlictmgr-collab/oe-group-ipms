import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import {
  type Ticket,
  URGENCY_STYLES,
  STATUS_STYLES,
  CHANNEL_LABELS,
  formatDateTime,
} from "@/lib/ticket-format";
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
    <div className="mx-auto max-w-2xl">
      <Link
        href="/dashboard"
        className="mb-4 inline-block text-sm text-neutral-500 hover:text-neutral-800"
      >
        ← Back to requests
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h1 className="text-lg font-semibold text-neutral-800">
            {t.summary ?? t.message_text}
          </h1>
          <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
            {t.urgency && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                  URGENCY_STYLES[t.urgency] ?? URGENCY_STYLES.normal
                }`}
              >
                {t.urgency}
              </span>
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                STATUS_STYLES[t.status] ?? STATUS_STYLES.open
              }`}
            >
              {t.status.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-4 border-t border-neutral-100 pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-400">Reference</dt>
            <dd className="font-mono text-sm font-semibold text-neutral-800">
              {shortRef(t.id)}
            </dd>
            <dd className="mt-0.5 break-all font-mono text-[10px] text-neutral-400">
              {t.id}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Channel</dt>
            <dd className="text-neutral-700">
              {CHANNEL_LABELS[t.channel] ?? t.channel}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Category</dt>
            <dd className="capitalize text-neutral-700">{t.category ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">Property / Unit</dt>
            <dd className="text-neutral-700">{t.property_or_unit ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">Created</dt>
            <dd className="text-neutral-700">{formatDateTime(t.created_at)}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">Human review</dt>
            <dd className="text-neutral-700">
              {t.requires_human_review ? "Flagged" : "Not required"}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Assigned to</dt>
            <dd className="text-neutral-700">
              {assignedVendorName ?? (t.assigned_to_user_id ? "Ops staff" : "—")}
              {t.acknowledged_at && (
                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                  acknowledged
                </span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-neutral-100 pt-4">
          <dt className="mb-1 text-sm text-neutral-400">Original message</dt>
          <p className="whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-sm text-neutral-700">
            {t.message_text}
          </p>
        </div>

        {needsAck && (
          <div className="mt-4 border-t border-neutral-100 pt-4">
            <AcknowledgeControl ticketId={t.id} />
          </div>
        )}

        {canManage && (
          <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4">
            <AssignControl
              ticketId={t.id}
              vendors={vendors}
              opsStaff={opsStaff}
              currentVendorId={t.assigned_vendor_id}
              currentOpsUserId={t.assigned_to_user_id}
            />
            <TicketStatusControl ticketId={t.id} currentStatus={t.status} />
          </div>
        )}
      </div>
    </div>
  );
}
