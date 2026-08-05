import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Plus, Inbox, Clock, MessageSquareReply, CheckCircle2, Wrench, Star,
} from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// A tenant's own requests, with the timeline they are actually owed.
//
// The requests list shows what happened; this shows WHERE IT IS — raised,
// acknowledged, resolved — and how long each step took. That is the question a
// tenant with a leaking tap is really asking, and "status: in_progress" does not
// answer it.
//
// Read through `my_requests()`, which is SECURITY DEFINER on `sender_id =
// auth.uid()`. A tenant has no read on `vendors` or `properties`, so the vendor's
// NAME comes back denormalised rather than by granting access to the register it
// lives in — the same shape `my_tenancies()` uses.

export const dynamic = "force-dynamic";

type RequestRow = {
  ticket_id: string;
  summary: string | null;
  category: string;
  urgency: string;
  status: string;
  created_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  hours_open: number | string;
  assigned_to: string | null;
  awaiting_review: boolean;
};

const DONE = new Set(["resolved", "closed"]);

const fmt = (d: string | null) =>
  d
    ? new Date(d).toLocaleString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short",
        year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

function elapsed(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** One step of the request's life. Undated steps are shown as not-yet-reached. */
function Step({
  icon, label, at, note, done, last,
}: {
  icon: React.ReactNode;
  label: string;
  at: string | null;
  note?: string;
  done: boolean;
  last?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full [&_svg]:size-3.5",
            done ? "bg-success/12 text-success" : "bg-muted text-muted-foreground"
          )}
        >
          {icon}
        </span>
        {!last && <span className={cn("w-px flex-1", done ? "bg-success/30" : "bg-border")} />}
      </div>
      <div className={cn("min-w-0 pb-4", last && "pb-0")}>
        <p className={cn("text-sm font-medium", !done && "text-muted-foreground")}>{label}</p>
        <p className="text-xs text-muted-foreground">
          {at ?? (done ? "—" : "Not yet")}
          {note ? ` · ${note}` : ""}
        </p>
      </div>
    </div>
  );
}

export default async function MyRequestsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  // A viewer has no policy on tickets; the page that is theirs is the overview.
  if (session.profile?.role === "viewer") redirect("/dashboard/overview");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_requests");
  const rows = (data ?? []) as RequestRow[];

  const openCount = rows.filter((r) => !DONE.has(r.status)).length;

  const newRequest = (
    <Button asChild variant="brand">
      <Link href="/dashboard/new"><Plus /> New Request</Link>
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Requests"
        description={
          rows.length === 0
            ? "Requests you have raised will appear here."
            : `${rows.length} request${rows.length === 1 ? "" : "s"} raised · ${openCount} still open.`
        }
        actions={newRequest}
      />

      {error ? (
        <EmptyState
          icon={<Inbox />}
          title="Could not load your requests"
          description="Please try again in a moment. If it keeps happening, contact your property manager."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No requests yet"
          description="Raise a request for a repair, a complaint or a question and you can follow its progress here."
          action={newRequest}
        />
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const done = DONE.has(r.status);
            const hrs = Number(r.hours_open);
            return (
              <Card key={r.ticket_id}>
                <CardContent className="space-y-4 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium leading-snug">{r.summary ?? "Request"}</p>
                      <p className="text-xs text-muted-foreground">
                        Reference {r.ticket_id.slice(0, 8).toUpperCase()} ·{" "}
                        {r.category.replace(/_/g, " ")}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <StatusBadge status={r.urgency} />
                      <StatusBadge status={r.status} />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-muted/30 p-3 sm:p-4">
                    <Step
                      icon={<Inbox />} label="Raised" at={fmt(r.created_at)} done last={false}
                    />
                    <Step
                      icon={<MessageSquareReply />}
                      label="Acknowledged"
                      at={fmt(r.first_response_at)}
                      done={Boolean(r.first_response_at)}
                    />
                    <Step
                      icon={<Wrench />}
                      label="Assigned to a contractor"
                      at={r.assigned_to}
                      done={Boolean(r.assigned_to)}
                    />
                    <Step
                      icon={<CheckCircle2 />}
                      label="Completed"
                      at={fmt(r.resolved_at)}
                      done={Boolean(r.resolved_at)}
                      last
                    />
                  </div>

                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="size-3.5" />
                    {/* A request closed before the system recorded completion
                        times has no duration. Saying "open for 400 days" about a
                        request that is plainly closed is worse than saying
                        nothing — `hours_open` counts to now() when there is no
                        resolution stamp to count to. */}
                    {done && !r.resolved_at
                      ? "Completed. The completion time was not recorded."
                      : done
                        ? `Closed in ${elapsed(hrs)}.`
                        : `Open for ${elapsed(hrs)}.`}
                  </p>

                  {r.awaiting_review && (
                    <Button asChild variant="outline" size="sm" className="w-full">
                      <Link href={`/dashboard/tickets/${r.ticket_id}`}>
                        <Star className="size-4" /> Rate this job
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
