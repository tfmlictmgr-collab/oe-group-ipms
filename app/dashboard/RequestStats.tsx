"use client";

import { Inbox, TriangleAlert, ShieldAlert } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { type Ticket } from "@/lib/ticket-format";
import { shortRef } from "@/lib/acknowledgement";

const OPEN_STATES = ["open", "assigned", "acknowledged", "in_progress"];

function toRecord(t: Ticket): DrawerRecord {
  return {
    id: t.id,
    title: t.summary ?? t.message_text.slice(0, 80),
    meta: [shortRef(t.id), t.category?.replace(/_/g, " "), t.property_or_unit].filter(Boolean).join(" · "),
    tone: t.urgency === "critical" ? "destructive" : t.urgency === "high" ? "warning" : undefined,
    tag: t.urgency ?? undefined,
    href: `/dashboard/tickets/${t.id}`,
  };
}

/**
 * Three summary tiles above the shared Requests list.
 *
 * ⚠️ Additive to the list below, not a replacement for it. `TicketList`
 * already has its own realtime subscription and status filter tabs — the
 * working tool for the job. These tiles are a point-in-time snapshot from
 * the same server fetch that seeded that list, useful for "how bad is it
 * right now" at a glance; they will not silently update the way the list
 * below them does, which is why the drawer says when the count was taken
 * rather than implying it is live.
 *
 * No fetch here, same rule as every other stat tile in this pass: `tickets`
 * is exactly what the page already loaded under the viewer's own RLS scope.
 */
export default function RequestStats({
  tickets,
  truncated,
  total,
}: {
  tickets: Ticket[];
  truncated: boolean;
  total: number;
}) {
  const drawer = useDrawer();
  const asOf = "as of this page loading — the list below stays live";

  const open = tickets.filter((t) => OPEN_STATES.includes(t.status));
  const urgent = open.filter((t) => t.urgency === "critical" || t.urgency === "high");
  const needsReview = open.filter((t) => t.requires_human_review);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open requests" value={open.length} icon={<Inbox />}
          hint={truncated ? `of ${total.toLocaleString()} total` : undefined}
          onClick={() => drawer.open({
            eyebrow: "Requests", title: "Open requests", scope: `${open.length} open, ${asOf}`,
            records: open.map(toRecord), emptyLabel: "Nothing open right now.",
          })}
        />
        <StatCard
          label="Critical & high urgency" value={urgent.length} icon={<TriangleAlert />}
          onClick={() => drawer.open({
            eyebrow: "Requests", title: "Critical & high urgency", scope: `${urgent.length} open, ${asOf}`,
            records: urgent.map(toRecord), emptyLabel: "Nothing urgent open right now.",
          })}
        />
        <StatCard
          label="Needs human review" value={needsReview.length} icon={<ShieldAlert />}
          onClick={() => drawer.open({
            eyebrow: "Requests", title: "Needs human review",
            scope: `${needsReview.length} the classifier could not resolve on its own, ${asOf}`,
            records: needsReview.map(toRecord), emptyLabel: "Nothing waiting on a human review.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
