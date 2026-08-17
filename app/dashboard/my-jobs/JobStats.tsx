"use client";

import * as React from "react";
import { Wrench, Clock, CheckCircle2 } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { shortRef } from "@/lib/acknowledgement";

export type Job = {
  id: string;
  summary: string | null;
  message_text: string | null;
  category: string;
  urgency: string;
  status: string;
  assigned_at: string | null;
  acknowledged_at: string | null;
  property_or_unit: string | null;
};

const OPEN_STATES = ["open", "assigned", "acknowledged", "in_progress"];

function toRecord(j: Job): DrawerRecord {
  return {
    id: j.id,
    title: j.summary ?? j.message_text ?? "Job",
    meta: [shortRef(j.id), j.category.replace(/_/g, " "), j.property_or_unit]
      .filter(Boolean).join(" · "),
    tone: j.urgency === "critical" || j.urgency === "high" ? "warning" : undefined,
    tag: !j.acknowledged_at && OPEN_STATES.includes(j.status) ? "Needs ack" : undefined,
    href: `/dashboard/tickets/${j.id}`,
  };
}

/**
 * The three stat tiles at the top of My Jobs, each opening onto the jobs
 * behind it.
 *
 * ⚠️ No fetch here. `jobs` is exactly what the server component above already
 * loaded, RLS-scoped to this viewer's own assignments — the drawer is a
 * richer look at data the page already legitimately holds, not a new query.
 */
export default function JobStats({ jobs }: { jobs: Job[] }) {
  const drawer = useDrawer();

  const open = jobs.filter((j) => OPEN_STATES.includes(j.status));
  const unacknowledged = open.filter((j) => !j.acknowledged_at);
  const done = jobs.filter((j) => !OPEN_STATES.includes(j.status));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open" value={String(open.length)} icon={<Wrench />}
          onClick={() => drawer.open({
            eyebrow: "My Jobs", title: "Open jobs", scope: `${open.length} dispatched to you`,
            records: open.map(toRecord), emptyLabel: "Nothing open right now.",
          })}
        />
        <StatCard
          label="Awaiting your acknowledgement" value={String(unacknowledged.length)} icon={<Clock />}
          onClick={() => drawer.open({
            eyebrow: "My Jobs", title: "Awaiting acknowledgement",
            scope: "Open a job to confirm you have it",
            records: unacknowledged.map(toRecord), emptyLabel: "Nothing waiting on you.",
          })}
        />
        <StatCard
          label="Completed" value={String(done.length)} icon={<CheckCircle2 />}
          onClick={() => drawer.open({
            eyebrow: "My Jobs", title: "Completed", scope: `${done.length} finished or closed`,
            records: done.map(toRecord), emptyLabel: "Nothing completed yet.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
