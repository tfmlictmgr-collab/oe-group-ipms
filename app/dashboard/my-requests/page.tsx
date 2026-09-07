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
import { ChatWithUs } from "@/components/patterns/chat-with-us";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [{ data, error }, tenanciesRes] = await Promise.all([
    supabase.rpc("my_requests"),
    // ⚠️ The tenant's own home screen did not say where they live. Asked for
    // directly — "tenant should see their allocated apartment" — and the data
    // has been there the whole time: `my_tenancies()` has returned
    // `property_name` and `unit_label` since 0110, and only /dashboard/my-rent
    // ever read it. So a resident's landing page listed their complaints and
    // named neither their flat nor their building, and the one screen that did
    // was filed under RENT, which is not where somebody looks for their address.
    //
    // Read through the definer function, not the register: a tenant reaches
    // `properties` and `units` through their tenancy (0226) and this needs no
    // wider door than the one that already exists.
    supabase.rpc("my_tenancies"),
  ]);
  const rows = (data ?? []) as RequestRow[];

  type Tenancy = {
    lease_id: string;
    property_name: string | null;
    unit_label: string | null;
    status: string;
    end_date: string | null;
  };
  // Live tenancies only. An expired one is a fact about the past and printing
  // it beside "your home" would tell somebody they live somewhere they left.
  const tenancies = ((tenanciesRes.data ?? []) as Tenancy[]).filter(
    (t) => t.status === "active" || t.status === "renewed"
  );

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

      {tenancies.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {tenancies.length === 1 ? "Your home" : "Your tenancies"}
            </CardTitle>
            <CardDescription>
              What you rent, and where. Raise a request against it from the
              button above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {tenancies.map((t) => (
              <div
                key={t.lease_id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {t.unit_label ?? "Your unit"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.property_name ?? "—"}
                  </p>
                </div>
                {t.end_date && (
                  <p className="text-xs text-muted-foreground">
                    Tenancy to{" "}
                    {new Date(t.end_date).toLocaleDateString("en-NG", {
                      day: "numeric", month: "short", year: "numeric",
                    })}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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

      {/*
        Placed at page level rather than on each request card, for two reasons:
        a card-level button repeated down a list of eight requests is noise, and
        a tenant with NO requests — the empty state above, and the person most
        likely to need help — would never see one. No reference is passed here
        because the question at this level is usually not about a specific
        request; the reference-scoped version lives on the request itself.
      */}
      <Card>
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="space-y-1">
            <p className="text-sm font-medium">Prefer to message us?</p>
            <p className="text-xs text-muted-foreground">
              Raise a request or ask a question on the app you already use. We
              answer in the same place.
            </p>
          </div>
          <ChatWithUs theme={session.theme} size="sm" />
        </CardContent>
      </Card>
    </div>
  );
}
