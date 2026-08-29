import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, ClipboardPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { type Ticket } from "@/lib/ticket-format";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import TicketList from "./TicketList";
import RequestStats from "./RequestStats";
import ScopeTabs from "./ScopeTabs";
import { FM_PM } from "@/lib/roles";
import { parseScope, showsScopeTabs, scopeLabel, scopesFor } from "./request-scope";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  // A viewer has no policy on tickets, so this page would render an empty list
  // that reads as a broken build rather than a withheld one. Send them to the
  // page that is actually theirs.
  const session = await getSessionProfile();
  if (session?.profile?.role === "viewer") redirect("/dashboard/overview");
  // A tenant's rows here and on the tracker are the same rows — RLS narrows both
  // to what they raised. The tracker adds the timeline they actually want, so it
  // replaces this page rather than sitting beside it under a second name.
  if (session?.profile?.role === "tenant") redirect("/dashboard/my-requests");
  // Same reasoning for a contractor: this list would hold only the jobs they were
  // dispatched, which is what My Work shows — with their score and pay status
  // beside it.
  if (session?.profile?.role === "vendor") redirect("/dashboard/my-work");

  const canRaiseWork = ["admin", ...FM_PM, "regional_manager"].includes(
    session?.profile?.role ?? ""
  );

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Which desk this page is showing. The DEFAULT is what the board direction
  // moved — an FM/PM lands on their own assigned work rather than on every
  // request across their properties. The other view stays one click away
  // because triage depends on it (0178).
  const scope = parseScope((await searchParams)?.view, session?.profile?.role);

  // Bounded deliberately. Unbounded, this hit PostgREST's 1000-row cap and older
  // requests dropped off the list with nothing to say so — the reader would
  // believe they were seeing everything. A stated limit is honest; a silent one
  // is not. Proper keyset pagination is Day 10 work.
  const REQUEST_PAGE = 200;
  let q = supabase
    .from("tickets")
    .select(
      "id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at, assigned_to_user_id",
      { count: "exact" }
    );

  // ⚠️ Applied SERVER-side, not by filtering the fetched page. With a 200-row
  // cap, narrowing after the fact would let 200 unassigned requests push a
  // manager's own three off the end — and the page would say "no requests
  // assigned to you" while three sat waiting.
  if (scope === "mine" && user) q = q.eq("assigned_to_user_id", user.id);
  // Decision 23. `sender_id` is already a clause of `tickets_select`, so this
  // narrows what RLS returned rather than widening it — an FM sees the requests
  // they raised because the policy has always allowed it, not because this line
  // says so.
  if (scope === "raised" && user) q = q.eq("sender_id", user.id);

  const { data: tickets, count } = await q
    .order("created_at", { ascending: false })
    .limit(REQUEST_PAGE);

  const total = count ?? 0;
  const truncated = total > REQUEST_PAGE;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service Requests"
        description={
          scope === "mine"
            ? "The requests assigned to you, updating in real time."
            : scope === "raised"
              ? "The requests you logged yourself, updating in real time."
              : "Requests you have access to, updating in real time."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Work an FM/PM initiates. Distinct from "New Request", which
                files a report on somebody's behalf — planned work has no
                reporter, and conflating the two is why there was nowhere to
                record it. */}
            {canRaiseWork && (
              <Button asChild variant="brand">
                <Link href="/dashboard/work">
                  <ClipboardPlus /> Raise Work
                </Link>
              </Button>
            )}
            <Button asChild variant={canRaiseWork ? "outline" : "brand"}>
              <Link href="/dashboard/new">
                <Plus /> New Request
              </Link>
            </Button>
          </div>
        }
      />
      {showsScopeTabs(session?.profile?.role) && (
        <ScopeTabs
          active={scope}
          role={session?.profile?.role ?? null}
          propertiesLabel={scopeLabel("properties", session?.profile?.role)}
          scopes={scopesFor(session?.profile?.role)}
        />
      )}

      <RequestStats tickets={(tickets as Ticket[]) ?? []} truncated={truncated} total={total} />

      <TicketList
        initialTickets={(tickets as Ticket[]) ?? []}
        scope={scope}
        viewerId={user?.id ?? null}
      />

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the {REQUEST_PAGE} most recent of {total.toLocaleString()} requests.
        </p>
      )}
    </div>
  );
}
