import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Inbox, CheckCircle2, Timer, CircleDot } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatCard } from "@/components/patterns/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { loadDrill, type DrillDimension } from "../../drill";
import { DrillMixedChart, periodLabel } from "../../AnalyticsCharts";
import type { Filters } from "../../actions";

// The drill-down target — a full PAGE, not a panel.
//
// Chosen over a slide-out drawer (board direction, Aug 2026) because a drill
// target is a thing people send to each other: it deep-links, it prints, and it
// survives a refresh. A drawer keeps the console's place, which is the better
// answer for comparing two months quickly; a page is the better answer for
// "look at this one, here is the link".
//
// ⚠️ Scope is re-checked in `loadDrill`, NOT here and NOT by the console that
// linked in. This route can be reached by a pasted URL or a stale bookmark, so
// the dashboard's gate cannot stand in for it.

export const dynamic = "force-dynamic";

const DIMENSIONS: DrillDimension[] = ["period", "property", "category", "vendor"];

const titleize = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const hours = (n: number | null) =>
  n === null ? "—" : n < 48 ? `${n.toFixed(1)} h` : `${(n / 24).toFixed(1)} d`;

const DIM_NOUN: Record<DrillDimension, string> = {
  period: "Period",
  property: "Property",
  category: "Category",
  vendor: "Vendor",
};

export default async function DrillPage({
  params,
  searchParams,
}: {
  params: Promise<{ dim: string; value: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const { dim, value } = await params;
  const sp = await searchParams;

  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  if (!DIMENSIONS.includes(dim as DrillDimension)) {
    return (
      <Refusal
        title="That is not a drill-down"
        description="The link may be mistyped. Open the console and click through from a figure."
      />
    );
  }

  // The console's filters travel in the query string, so a drill target is the
  // same slice the reader was looking at — not a fresh unfiltered query that
  // happens to share a heading.
  const filters: Filters = {
    from: one("from"),
    to: one("to"),
    vendorId: one("vendor"),
    category: one("category"),
    propertyId: one("property"),
    status: one("status"),
    bucket: (one("bucket") as Filters["bucket"]) ?? "month",
  };

  // ⚠️ NOT `decodeURIComponent(value)`. Next.js has already decoded the dynamic
  // segment, so decoding a second time corrupts any value containing a literal
  // `%` — and on a crafted URL like `/period/%zz` it throws URIError, which
  // surfaces as a 500 rather than the refusal below. The console encodes on the
  // way out; one decode on the way in is the whole of it.
  const res = await loadDrill(dim as DrillDimension, value, filters);

  if (!res.ok) {
    return <Refusal title={res.message} description={res.hint ?? undefined} />;
  }

  const d = res.data;
  const backQuery = new URLSearchParams(
    Object.entries({
      from: filters.from, to: filters.to, vendor: filters.vendorId,
      category: filters.category, property: filters.propertyId,
      status: filters.status, bucket: filters.bucket,
    }).filter(([, v]) => Boolean(v)) as [string, string][]
  ).toString();

  // ⚠️ Both buckets come from `loadDrill`, which is the one place that decides
  // how wide the opened period is. Labelling it here from the URL's own shape is
  // what made a month read "Aug 26" over a single day's figures: the width of a
  // period is not recoverable from its start date, and `bi_ticket_metrics`
  // returns a full date at every bucket.
  const heading =
    d.dimension === "period"
      ? periodLabel(d.label, d.bucket)
      : d.dimension === "category"
        ? titleize(d.label)
        : d.label;

  // One level finer than what was opened. Stated on screen because a chart
  // whose grouping is not named is a chart the reader has to guess at.
  const innerBucket = d.innerBucket;

  return (
    <div className="space-y-6">
      <PageHeader
        title={heading}
        description={`${DIM_NOUN[d.dimension]} · ${d.totals.total.toLocaleString()} request${d.totals.total === 1 ? "" : "s"}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/dashboard/bi/analytics${backQuery ? `?${backQuery}` : ""}`}>
              <ArrowLeft /> Back to the console
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Requests raised" value={d.totals.total.toLocaleString()} icon={<Inbox />} />
        <StatCard
          label="Completed"
          value={d.totals.completed.toLocaleString()}
          icon={<CheckCircle2 />}
          hint={d.totals.completionPct === null ? "—" : `${d.totals.completionPct}% completion rate`}
        />
        <StatCard label="Avg. time to resolve" value={hours(d.totals.avgResolve)} icon={<Timer />} />
        <StatCard
          label="Still open"
          value={d.totals.open.toLocaleString()}
          icon={<CircleDot />}
          hint={`of the ${Math.min(d.tickets.length, 100)} most recent`}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Volume and speed</CardTitle>
          <CardDescription>
            Requests raised and completed per {innerBucket}, with average
            resolution time on the right-hand axis. A gap in the line is a{" "}
            {innerBucket} in which nothing was resolved and timed — not a zero.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <DrillMixedChart data={d.series} bucket={innerBucket} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">The requests behind this figure</CardTitle>
          <CardDescription>
            {d.tickets.length >= 100
              ? "The 100 most recent. Narrow the period to see further back."
              : `All ${d.tickets.length} of them, most recent first.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {d.tickets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No requests in this slice.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Request</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Raised</TableHead>
                    <TableHead className="text-right">Resolved in</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.tickets.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/dashboard/tickets/${t.id}`} className="hover:underline">
                          {t.reference}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[24rem] truncate">
                        {t.summary ?? <span className="text-muted-foreground">no summary</span>}
                      </TableCell>
                      <TableCell>{t.category ? titleize(t.category) : "—"}</TableCell>
                      <TableCell>
                        <Badge variant={["resolved", "closed"].includes(t.status) ? "muted" : "outline"}>
                          {titleize(t.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {new Date(t.created_at).toLocaleDateString("en-NG", {
                          day: "numeric", month: "short", year: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.hours_to_resolve === null
                          ? <span className="text-muted-foreground">—</span>
                          : hours(t.hours_to_resolve)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The same shape for every refusal — an unknown dimension, a property that is
 * not this person's, and one that does not exist all land here. Deliberately
 * indistinguishable: a refusal that says which of the three it was tells a
 * caller which ids are real.
 */
function Refusal({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" />
      <EmptyState
        icon={<Inbox />}
        title={title}
        description={description ?? "Open the console and click through from a figure."}
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard/bi/analytics"><ArrowLeft /> Back to the console</Link>
          </Button>
        }
      />
    </div>
  );
}
