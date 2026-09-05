import Link from "next/link";
import { redirect } from "next/navigation";
import { HardHat, ChevronRight, ReceiptText } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { shortRef } from "@/lib/acknowledgement";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import JobStats from "./JobStats";
import LiveRefresh from "@/components/patterns/live-refresh";

// An internal ops staffer's own dispatched work.
//
// ⚠️ This role could be SENT work and had nowhere to LOOK at it. `assignTicket`
// offers `fm_ops_staff` in the dispatch control alongside vendors, the RLS lets
// them read what they are given (verified live across every org — an ops
// staffer assigned a ticket can select it), and `notify_user` tells them a job
// has arrived with a link. The navigation had no entry, so the link in the
// notification was the only route to work assigned to them, and the menu
// offered the shared operational requests list instead — every ticket in scope,
// with no indication which were theirs.
//
// The same gap the vendor had before `/dashboard/my-work`, and the same fix.
//
// ⚠️ Nothing here filters by user id. Every query is the plain table with an
// `assigned_to_user_id` predicate the policy would enforce anyway — stated so
// the page shows THEIR jobs rather than everything they may read, not to make
// it safe. If a policy were ever loosened this page must widen with it,
// visibly, rather than silently masking the fault.

export const dynamic = "force-dynamic";

const OPEN_STATES = ["open", "assigned", "acknowledged", "in_progress"];

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";

export default async function MyJobsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase
    .from("tickets")
    .select(
      "id, summary, message_text, category, urgency, status, created_at, assigned_at, acknowledged_at, property_or_unit"
    )
    .eq("assigned_to_user_id", session.user.id)
    .order("assigned_at", { ascending: false, nullsFirst: false });

  const jobs = (data ?? []) as {
    id: string;
    summary: string | null;
    message_text: string | null;
    category: string;
    urgency: string;
    status: string;
    created_at: string;
    assigned_at: string | null;
    acknowledged_at: string | null;
    property_or_unit: string | null;
  }[];

  return (
    <div className="space-y-6">
      {/* A dispatched job appears without the operative reloading — it
          reached their notifications and not their list. */}
      <LiveRefresh />
      <PageHeader
        title="My Jobs"
        description="Work dispatched to you. Open a job to acknowledge it and record progress."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/requisitions/new">
              <ReceiptText /> Raise a requisition
            </Link>
          </Button>
        }
      />

      {jobs.length === 0 ? (
        <EmptyState
          icon={<HardHat />}
          title="No jobs assigned to you yet"
          description="When a facility manager dispatches a job to you it appears here, and you are notified on your chosen channel."
        />
      ) : (
        <>
          <JobStats jobs={jobs} />

          <ul className="space-y-2.5">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/dashboard/tickets/${j.id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium">
                      {j.summary ?? j.message_text ?? "Job"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {shortRef(j.id)} · {j.category.replace(/_/g, " ")}
                      {j.property_or_unit ? ` · ${j.property_or_unit}` : ""}
                      {j.assigned_at ? ` · dispatched ${fmtDate(j.assigned_at)}` : ""}
                    </p>
                    {/* The one thing an ops staffer is actually being asked to
                        do next, said rather than implied by a status word. */}
                    {OPEN_STATES.includes(j.status) && !j.acknowledged_at && (
                      <p className="text-xs text-warning">
                        Not yet acknowledged — open it to confirm you have it.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <StatusBadge status={j.urgency} />
                    <StatusBadge status={j.status} />
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* B7 gives this role assigned work and their own actions, and nothing
          else — no money, no register, no org-wide read. Stated plainly so the
          absence reads as a boundary rather than a missing feature. */}
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          You see the jobs dispatched to you and your own activity on them.
          Budgets, vendor payments and the wider property register belong to your
          facility manager.
        </CardContent>
      </Card>
    </div>
  );
}
