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
import { shortRef } from "@/lib/acknowledgement";

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
      "id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at"
    )
    .eq("id", id)
    .single();

  if (!ticket) notFound();
  const t = ticket as Ticket;

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
        </dl>

        <div className="mt-4 border-t border-neutral-100 pt-4">
          <dt className="mb-1 text-sm text-neutral-400">Original message</dt>
          <p className="whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-sm text-neutral-700">
            {t.message_text}
          </p>
        </div>

        {canManage && (
          <div className="mt-4 border-t border-neutral-100 pt-4">
            <TicketStatusControl ticketId={t.id} currentStatus={t.status} />
          </div>
        )}
      </div>
    </div>
  );
}
