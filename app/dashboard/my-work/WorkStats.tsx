"use client";

import * as React from "react";
import { Briefcase, CheckCircle2, Star, Banknote } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { formatNaira } from "@/lib/currency";
import { shortRef } from "@/lib/acknowledgement";
import { scoreBand } from "@/lib/vendor-score";

const OPEN_STATES = ["open", "assigned", "acknowledged", "in_progress"];

type Job = {
  id: string; summary: string | null; message_text: string | null;
  category: string | null; status: string; property_or_unit: string | null;
};
type Evaluation = {
  ticket_id: string; composite_score: number | string | null;
  fm_pm_submitted_at: string | null;
};
type Payment = {
  id: string; invoice_reference: string | null; amount: number | string;
  status: string; created_at: string; rejected_reason: string | null;
};

const STAGE_MEANING: Record<string, string> = {
  pending_verification: "with your facility manager",
  verified: "performance check next",
  recommended: "with finance to approve",
  approved: "payment being arranged",
  remitted: "paid",
  rejected: "not approved",
};

/**
 * The four tiles on My Work, each opening onto what it counts.
 *
 * ⚠️ No fetch here — same reasoning as JobStats. Two of the four tiles
 * (Open jobs, Completed) are honest about their own limit rather than
 * silently under-representing it: `openCount`/`doneCount` come from a
 * database COUNT (true past the 100-row list this page bounds itself to,
 * per audit 0804 C1's own fix), but the DRAWER can only show records from
 * the bounded list it was handed — so it says "the N most recent" rather
 * than implying it holds all of them.
 */
export default function WorkStats({
  jobs,
  openCount,
  doneCount,
  listTruncated,
  complete,
  average,
  awaitingCount,
  payments,
  awaitingTotal,
}: {
  jobs: Job[];
  openCount: number;
  doneCount: number;
  listTruncated: boolean;
  complete: Evaluation[];
  average: number | null;
  awaitingCount: number;
  payments: Payment[];
  awaitingTotal: number;
}) {
  const drawer = useDrawer();
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const open = jobs.filter((j) => OPEN_STATES.includes(j.status));
  const done = jobs.filter((j) => !OPEN_STATES.includes(j.status));
  const unsettled = payments.filter((p) => p.status !== "remitted" && p.status !== "rejected");

  const jobRecord = (j: Job): DrawerRecord => ({
    id: j.id,
    title: j.summary ?? j.message_text ?? "Job",
    meta: [shortRef(j.id), j.category?.replace(/_/g, " "), j.property_or_unit].filter(Boolean).join(" · "),
    href: `/dashboard/tickets/${j.id}`,
  });

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open jobs" value={openCount} icon={<Briefcase />}
          onClick={() => drawer.open({
            eyebrow: "My Work", title: "Open jobs",
            scope: listTruncated ? `Showing the ${open.length} most recent of ${openCount}` : `${openCount} outstanding`,
            records: open.map(jobRecord), emptyLabel: "Nothing outstanding.",
          })}
        />
        <StatCard
          label="Completed" value={doneCount} icon={<CheckCircle2 />}
          onClick={() => drawer.open({
            eyebrow: "My Work", title: "Completed",
            scope: listTruncated ? `Showing the ${done.length} most recent of ${doneCount}` : `${doneCount} all time`,
            records: done.map(jobRecord), emptyLabel: "Nothing completed yet.",
          })}
        />
        <StatCard
          label="Performance score" value={average === null ? "—" : average.toFixed(1)} icon={<Star />}
          onClick={() => drawer.open({
            eyebrow: "My Work", title: "Performance score",
            scope: average === null
              ? "No evaluation recorded yet"
              : `${scoreBand(average).label} · averaged over ${complete.length} job${complete.length === 1 ? "" : "s"}`,
            records: complete.map((e) => {
              const j = jobById.get(e.ticket_id);
              return {
                id: e.ticket_id,
                title: j ? (j.summary ?? j.message_text ?? "Job") : `Job ${shortRef(e.ticket_id)}`,
                meta: e.fm_pm_submitted_at
                  ? new Date(e.fm_pm_submitted_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" })
                  : undefined,
                tag: e.composite_score == null ? undefined : Number(e.composite_score).toFixed(1),
                tone: e.composite_score == null ? undefined
                  : Number(e.composite_score) >= 70 ? "success" : "warning",
                href: `/dashboard/tickets/${e.ticket_id}`,
              };
            }),
            emptyLabel: awaitingCount > 0
              ? `${awaitingCount} job${awaitingCount === 1 ? " is" : "s are"} evaluated on one side only.`
              : "No evaluation recorded yet.",
          })}
        />
        <StatCard
          label="Awaiting payment" value={formatNaira(awaitingTotal)} icon={<Banknote />}
          onClick={() => drawer.open({
            eyebrow: "My Work", title: "Awaiting payment",
            scope: `${unsettled.length} invoice${unsettled.length === 1 ? "" : "s"} not yet remitted`,
            records: unsettled.map((p) => ({
              id: p.id,
              title: p.invoice_reference ?? p.id.slice(0, 8).toUpperCase(),
              meta: `${formatNaira(Number(p.amount))} · ${STAGE_MEANING[p.status] ?? p.status}`,
              tag: p.status,
              tone: p.status === "rejected" ? "destructive" : "info",
            })),
            emptyLabel: "Nothing awaiting payment.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
