"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Inbox, CheckCircle2, Timer, MessageSquareReply, Download, FileText,
  RotateCcw, Trophy, TriangleAlert, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/patterns/stat-card";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { loadAnalytics, exportAnalyticsCsv, type Filters, type MetricRow, type VendorRow, type CategoryRow } from "./actions";
import {
  TrendChart, VendorSpeedBar, CategoryCompletionBar, periodLabel, isPartialPeriod,
} from "./AnalyticsCharts";

export type Option = { id: string; name: string };

const BUCKETS = [
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
] as const;

const STATUSES = ["open", "assigned", "acknowledged", "in_progress", "resolved", "closed"];

const titleize = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const hours = (n: number | null) =>
  n === null ? "—" : n < 48 ? `${n.toFixed(1)} h` : `${(n / 24).toFixed(1)} d`;

// ── Filter controls ────────────────────────────────────────────────────────

const FIELD =
  "h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── The console ────────────────────────────────────────────────────────────

export default function AnalyticsConsole({
  initial,
  initialFilters,
  vendors,
  properties,
  categories,
  showVendors,
}: {
  initial: { metrics: MetricRow[]; vendors: VendorRow[]; categories: CategoryRow[] };
  initialFilters: Filters;
  vendors: Option[];
  properties: Option[];
  categories: string[];
  /** B7: vendor scores are ops management, not every BI reader's business. */
  showVendors: boolean;
}) {
  const [filters, setFilters] = React.useState<Filters>(initialFilters);
  const [data, setData] = React.useState(initial);
  const [loading, setLoading] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const key = JSON.stringify(filters);
  const firstRender = React.useRef(true);

  React.useEffect(() => {
    // The server already rendered the initial filter set; refetching it on mount
    // would double every page load for an identical answer.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadAnalytics(JSON.parse(key) as Filters)
      .then((res) => {
        // A slow request for filters the reader has already moved off must not
        // land — otherwise the figures on screen belong to a filter set the
        // controls no longer show.
        if (cancelled) return;
        if (!res.ok) toast.error(res.message, { description: res.hint });
        else setData(res.data);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const reset = () => setFilters({ bucket: "month" });

  const bucket = filters.bucket ?? "month";
  const filtered =
    Boolean(filters.from || filters.to || filters.vendorId || filters.category ||
            filters.propertyId || filters.status);

  // ── Headline figures ─────────────────────────────────────────────────────
  //
  // Pooled from the period rows, each average weighted by ITS OWN population —
  // `timed` for resolution, `responded` for first response (0101). Weighting one
  // by the other's count is arithmetic across two different sets.
  const k = data.metrics.reduce(
    (a, m) => ({
      total: a.total + Number(m.total),
      completed: a.completed + Number(m.completed),
      timed: a.timed + Number(m.timed),
      responded: a.responded + Number(m.responded),
      resolveSum: a.resolveSum + (m.avg_hours_to_resolve === null ? 0
        : Number(m.avg_hours_to_resolve) * Number(m.timed)),
      responseSum: a.responseSum + (m.avg_hours_to_first_response === null ? 0
        : Number(m.avg_hours_to_first_response) * Number(m.responded)),
    }),
    { total: 0, completed: 0, timed: 0, responded: 0, resolveSum: 0, responseSum: 0 }
  );
  const completionPct = k.total > 0 ? (k.completed / k.total) * 100 : null;
  const avgResolve = k.timed > 0 ? k.resolveSum / k.timed : null;
  const avgResponse = k.responded > 0 ? k.responseSum / k.responded : null;

  // ── Period over period ───────────────────────────────────────────────────
  //
  // The last two COMPLETE buckets. Shown only when there are two: a "+100%"
  // drawn from a single period compared against nothing is the most confidently
  // wrong number a dashboard can print.
  //
  // ⚠️ The period in progress is dropped first. On 3 August, comparing a
  // three-day-old month against a full July produced "-81.3% raised" and
  // "-100% completed" — both arithmetically correct, both describing the
  // calendar rather than the business, and both sitting in red on an executive's
  // screen. A partial period is not a decline.
  //
  // Faster is better for durations, so the direction is inverted against volume —
  // a rising resolve time is a `down` (bad), not an `up`.
  const complete = data.metrics.filter((m) => !isPartialPeriod(m.period, bucket));
  const [prev, last] = complete.slice(-2);
  const delta = (now: number | null, before: number | null, lowerIsBetter = false) => {
    if (now === null || before === null || before === 0) return undefined;
    const change = ((now - before) / before) * 100;
    const improving = lowerIsBetter ? change < 0 : change > 0;
    return {
      value: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
      direction: (Math.abs(change) < 0.05 ? "flat" : improving ? "up" : "down") as
        "up" | "down" | "flat",
    };
  };
  const pop =
    complete.length >= 2 && last && prev
      ? {
          total: delta(Number(last.total), Number(prev.total)),
          completion: delta(
            last.completion_pct === null ? null : Number(last.completion_pct),
            prev.completion_pct === null ? null : Number(prev.completion_pct)
          ),
          resolve: delta(
            last.avg_hours_to_resolve === null ? null : Number(last.avg_hours_to_resolve),
            prev.avg_hours_to_resolve === null ? null : Number(prev.avg_hours_to_resolve),
            true
          ),
          response: delta(
            last.avg_hours_to_first_response === null ? null : Number(last.avg_hours_to_first_response),
            prev.avg_hours_to_first_response === null ? null : Number(prev.avg_hours_to_first_response),
            true
          ),
          label: `${periodLabel(last.period, bucket)} vs ${periodLabel(prev.period, bucket)}`,
        }
      : null;

  // ── Best and worst, among the measured ───────────────────────────────────
  const measured = data.vendors.filter(
    (v) => v.avg_hours_to_resolve !== null && Number(v.timed) > 0
  );
  const best = measured[0] ?? null;                       // the RPC orders fastest-first
  const worst = measured.length > 1 ? measured[measured.length - 1] : null;

  // ── Exports ──────────────────────────────────────────────────────────────
  const downloadCsv = async () => {
    setExporting(true);
    try {
      const res = await exportAnalyticsCsv(filters);
      if (!res.ok) { toast.error(res.message, { description: res.hint }); return; }
      // The BOM is for Excel: without it a name like "Ilorin — Block A" opens as
      // mojibake on a default Windows install.
      const blob = new Blob(["﻿", res.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `analytics-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const pdfHref = (() => {
    const q = new URLSearchParams();
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    if (filters.vendorId) q.set("vendor", filters.vendorId);
    if (filters.category) q.set("category", filters.category);
    if (filters.propertyId) q.set("property", filters.propertyId);
    if (filters.status) q.set("status", filters.status);
    q.set("bucket", bucket);
    return `/api/analytics/report?${q.toString()}`;
  })();

  return (
    <div className="space-y-6">
      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Field label="From">
              <input type="date" className={FIELD} value={filters.from ?? ""}
                     max={filters.to ?? undefined}
                     onChange={(e) => set({ from: e.target.value || null })} />
            </Field>
            <Field label="To">
              <input type="date" className={FIELD} value={filters.to ?? ""}
                     min={filters.from ?? undefined}
                     onChange={(e) => set({ to: e.target.value || null })} />
            </Field>
            <Field label="Property">
              <select className={FIELD} value={filters.propertyId ?? ""}
                      onChange={(e) => set({ propertyId: e.target.value || null })}>
                <option value="">All properties</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            {showVendors && (
              <Field label="Vendor">
                <select className={FIELD} value={filters.vendorId ?? ""}
                        onChange={(e) => set({ vendorId: e.target.value || null })}>
                  <option value="">All vendors</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Category">
              <select className={FIELD} value={filters.category ?? ""}
                      onChange={(e) => set({ category: e.target.value || null })}>
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{titleize(c)}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select className={FIELD} value={filters.status ?? ""}
                      onChange={(e) => set({ status: e.target.value || null })}>
                <option value="">Any status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{titleize(s)}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-input p-0.5">
                {BUCKETS.map((b) => (
                  <button
                    key={b.value} type="button"
                    onClick={() => set({ bucket: b.value })}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      bucket === b.value
                        ? "bg-[var(--brand)] text-[var(--brand-fg)]"
                        : "text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              {loading && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Updating
                </span>
              )}
              {filtered && !loading && (
                <Button variant="ghost" size="sm" onClick={reset}>
                  <RotateCcw /> Clear filters
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={downloadCsv} disabled={exporting}>
                <Download /> {exporting ? "Preparing…" : "CSV"}
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={pdfHref} target="_blank" rel="noopener noreferrer">
                  <FileText /> PDF report
                </a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Headline ──────────────────────────────────────────────────────── */}
      <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", "lg:grid-cols-4")}>
        <StatCard label="Requests raised" value={k.total.toLocaleString()} icon={<Inbox />}
                  trend={pop?.total}
                  hint={filtered ? "matching these filters" : "all time"} />
        <StatCard label="Completed" value={k.completed.toLocaleString()} icon={<CheckCircle2 />}
                  trend={pop?.completion}
                  hint={completionPct === null ? "—" : `${completionPct.toFixed(1)}% completion rate`} />
        <StatCard label="Avg. time to resolve" value={hours(avgResolve)} icon={<Timer />}
                  trend={pop?.resolve}
                  hint={`measured over ${k.timed.toLocaleString()} of ${k.completed.toLocaleString()} completed`} />
        <StatCard label="Avg. first response" value={hours(avgResponse)} icon={<MessageSquareReply />}
                  trend={pop?.response}
                  hint={`measured over ${k.responded.toLocaleString()} requests`} />
      </div>

      {pop && (
        <p className="text-xs text-muted-foreground">
          Arrows compare {pop.label}. For durations, a fall is an improvement.
        </p>
      )}

      {/* The caveat sits next to the numbers, not in a footnote nobody reads. */}
      {k.completed > k.timed && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {(k.completed - k.timed).toLocaleString()} completed request
            {k.completed - k.timed === 1 ? " was" : "s were"} closed before this system
            began recording resolution times. They are counted in the totals and
            excluded from every average — durations are never estimated.
          </span>
        </p>
      )}

      {/* ── Trend ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Volume and speed over time</CardTitle>
          <CardDescription>
            Requests raised and completed per {bucket}, with average resolution time on the right axis.
            {data.metrics.length > 0 &&
              isPartialPeriod(data.metrics[data.metrics.length - 1].period, bucket) && (
                <> The final bar is the current {bucket}, still in progress.</>
              )}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <TrendChart data={data.metrics} bucket={bucket} />
        </CardContent>
      </Card>

      {/* ── Best / worst ──────────────────────────────────────────────────── */}
      {showVendors && (best || worst) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {best && (
            <Card className="border-success/30">
              <CardContent className="flex items-start gap-3 p-4 sm:p-5">
                <span className="rounded-lg bg-success/12 p-2 text-success"><Trophy className="size-5" /></span>
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Fastest vendor
                  </p>
                  <p className="truncate text-lg font-semibold">{best.vendor_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {hours(best.avg_hours_to_resolve)} average over {Number(best.timed)} timed job
                    {Number(best.timed) === 1 ? "" : "s"} · {best.completion_pct ?? 0}% completion
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          {worst && (
            <Card className="border-warning/30">
              <CardContent className="flex items-start gap-3 p-4 sm:p-5">
                <span className="rounded-lg bg-warning/15 p-2 text-warning"><TriangleAlert className="size-5" /></span>
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Slowest vendor
                  </p>
                  <p className="truncate text-lg font-semibold">{worst.vendor_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {hours(worst.avg_hours_to_resolve)} average over {Number(worst.timed)} timed job
                    {Number(worst.timed) === 1 ? "" : "s"} · {worst.completion_pct ?? 0}% completion
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Breakdowns ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {showVendors && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Vendor turnaround</CardTitle>
              <CardDescription>
                Average hours to resolve. Vendors with nothing timed in this window are not shown —
                unmeasured is not fast.
                {filters.status && (
                  // Said out loud rather than left for the reader to notice. A
                  // completion rate computed within "completed only" is 100% for
                  // everyone, so this breakdown ignores the status filter — and a
                  // panel that quietly ignores a control the reader just set is
                  // how a figure gets misread.
                  <> The <strong>{titleize(filters.status)}</strong> status filter does not
                  apply here: completion rate within a single status says nothing.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <VendorSpeedBar data={data.vendors} />
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Completion by category</CardTitle>
            <CardDescription>
              Where the backlog actually sits.
              {(filters.category || filters.status) && (
                // A breakdown cannot be narrowed by the dimension it breaks down
                // by, and a rate within one status is meaningless — so this panel
                // stays wider than the headline. Stated, not silently different.
                <> Shown across all categories and statuses, so the{" "}
                {filters.category ? "category" : "status"} filter above does not narrow it.</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <CategoryCompletionBar data={data.categories} />
          </CardContent>
        </Card>
      </div>

      {/* ── The figures themselves ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Period detail</CardTitle>
          <CardDescription>The same figures the charts are drawn from.</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {data.metrics.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing matches these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Raised</TableHead>
                    <TableHead className="text-right">Completed</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Avg. resolve</TableHead>
                    <TableHead className="text-right">Avg. response</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.metrics.map((m) => (
                    <TableRow key={m.period}>
                      <TableCell className="font-medium">
                        {periodLabel(m.period, bucket)}
                        {/* Marked, so nobody reads a period still in progress as
                            a finished one that fell off a cliff. */}
                        {isPartialPeriod(m.period, bucket) && (
                          <Badge variant="outline" className="ml-2 font-normal">so far</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(m.total).toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(m.completed).toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.completion_pct === null ? "—" : `${Number(m.completion_pct).toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.avg_hours_to_resolve === null ? (
                          <Badge variant="muted">not timed</Badge>
                        ) : (
                          hours(Number(m.avg_hours_to_resolve))
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.avg_hours_to_first_response === null
                          ? "—" : hours(Number(m.avg_hours_to_first_response))}
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
