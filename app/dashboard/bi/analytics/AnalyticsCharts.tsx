"use client";

import {
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { usePalette, chartChrome, MixDonut, TrendLine } from "../Charts";
import type { MetricRow, VendorRow } from "./actions";

// Charts for the filterable console. Built on the same palette as the executive
// dashboard so a figure keeps its colour when a reader drills from one to the
// other.

function EmptyPlot({ height = 260, note }: { height?: number; note?: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-sm text-muted-foreground"
      style={{ height }}
    >
      {note ?? "Nothing matches these filters"}
    </div>
  );
}

/** Human month/quarter/week label from the bucket's start date. */
export function periodLabel(iso: string, bucket: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (bucket === "year") return String(y);
  if (bucket === "quarter") return `Q${Math.floor(m / 3) + 1} ${y}`;
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  // `day` and `week` both label by date. Without the day case every day inside
  // a month collapsed to the same "Aug 26" label, so a 31-bar chart read as one
  // bar repeated — the drill's finest level was the one it rendered worst.
  if (bucket === "day" || bucket === "week") return `${d.getUTCDate()} ${mon}`;
  return `${mon} ${String(y).slice(2)}`;
}

/**
 * When the bucket starting on `iso` ends — the first instant NOT in it.
 *
 * Used to tell a finished period from one still running. Today is 3 August; a
 * three-day-old month compared against a full July reads "-81% requests raised",
 * which is not a collapse in demand, it is a calendar.
 */
export function periodEnd(iso: string, bucket: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return new Date(8.64e15);
  const e = new Date(d);
  if (bucket === "day") e.setUTCDate(e.getUTCDate() + 1);
  else if (bucket === "week") e.setUTCDate(e.getUTCDate() + 7);
  else if (bucket === "quarter") e.setUTCMonth(e.getUTCMonth() + 3);
  else if (bucket === "year") e.setUTCFullYear(e.getUTCFullYear() + 1);
  else e.setUTCMonth(e.getUTCMonth() + 1);
  return e;
}

/** True when the bucket beginning on `iso` has not finished yet. */
export function isPartialPeriod(iso: string, bucket: string): boolean {
  return periodEnd(iso, bucket).getTime() > Date.now();
}

/**
 * Volume over time — raised against completed, both counts, ONE axis.
 *
 * ⚠️ This used to carry the average-resolve line as well, on a second y-axis,
 * and the comment defending it argued that counts and hours "share no scale".
 * That is exactly the reason not to draw them together: with two scales the
 * alignment between the bars and the line is arbitrary, so the plot invents a
 * relationship the data never contained — a line crossing above the bars means
 * nothing at all. It is the most common charting mistake there is.
 *
 * Speed now has its own plot (`ResolveSpeedLine`), on its own single axis, where
 * the shape of the line is the only thing it can be read against.
 */
export function TrendChart({
  data,
  bucket,
}: {
  data: MetricRow[];
  bucket: string;
}) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  if (data.length === 0) return <EmptyPlot height={280} />;

  const rows = data.map((r) => ({
    label: periodLabel(r.period, bucket),
    total: Number(r.total),
    completed: Number(r.completed),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barGap={2}>
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} formatter={(v) => Number(v).toLocaleString()} />
        <Legend wrapperStyle={{ fontSize: 12, color: p.muted }} />
        <Bar dataKey="total" name="Raised" fill={p.series1}
             radius={[4, 4, 0, 0]} maxBarSize={40} />
        <Bar dataKey="completed" name="Completed" fill={p.series2}
             radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * How long a request took to resolve, period by period — the other half of what
 * the old two-axis plot tried to say at once, now readable on its own terms.
 */
export function ResolveSpeedLine({
  data,
  bucket,
}: {
  data: MetricRow[];
  bucket: string;
}) {
  const points = data.map((r) => ({
    label: periodLabel(r.period, bucket),
    value: r.avg_hours_to_resolve === null ? null : Number(r.avg_hours_to_resolve),
  }));

  if (points.length === 0 || points.every((pt) => pt.value === null)) {
    return <EmptyPlot height={240} note="Nothing has been resolved and timed in this window yet" />;
  }

  return (
    <TrendLine
      data={points}
      height={240}
      unit="h"
      formatValue={(n) => `${n.toFixed(1)} h`}
    />
  );
}

/**
 * What the workload is made OF — the classification mix.
 *
 * A ring rather than another bar because the question here is composition, not
 * ranking: "half of everything is maintenance" is the reading, and no bar chart
 * says that as directly. Comparison between similar categories stays with the
 * completion-rate bars below, where lengths share a baseline.
 */
export function CategoryMixDonut({
  data,
}: {
  data: { category: string; total: number }[];
}) {
  const rows = data
    .map((c) => ({
      name: c.category.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      value: Number(c.total),
    }))
    .filter((r) => r.value > 0);

  if (rows.length === 0) return <EmptyPlot />;
  return <MixDonut data={rows} height={280} centreLabel="requests" />;
}

/**
 * Average hours to resolve, per vendor.
 *
 * Only vendors with something timed appear. An unmeasured vendor is dropped
 * rather than drawn at zero — a bar of zero height at the top of a "fastest"
 * chart is the exact misreading `bi_vendor_performance`'s `nulls last` ordering
 * exists to prevent.
 */
export function VendorSpeedBar({ data }: { data: VendorRow[] }) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);

  const rows = data
    .filter((v) => v.avg_hours_to_resolve !== null && Number(v.timed) > 0)
    .map((v) => ({
      name: v.vendor_name,
      hours: Number(v.avg_hours_to_resolve),
      timed: Number(v.timed),
    }))
    .slice(0, 10);

  if (rows.length === 0) {
    return <EmptyPlot note="No vendor has a timed completion in this window yet" />;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 32 + 60)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={p.grid} horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={(v: number) => `${v}h`} />
        <YAxis
          type="category" dataKey="name" width={130} {...axisProps}
          tick={{ fill: p.muted, fontSize: 11 }}
          tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, _n, item) =>
            `${Number(v).toFixed(1)} h over ${item?.payload?.timed ?? 0} timed`
          }
        />
        <Bar dataKey="hours" name="Avg. hours" fill={p.series1}
             radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Completion rate by classification — where the backlog actually sits. */
export function CategoryCompletionBar({
  data,
}: {
  data: { category: string; total: number; completion_pct: number | null }[];
}) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  const rows = data.map((c) => ({
    name: c.category.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
    pct: c.completion_pct === null ? 0 : Number(c.completion_pct),
    total: Number(c.total),
  }));
  if (rows.length === 0) return <EmptyPlot />;

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 34 + 60)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={p.grid} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} {...axisProps}
               tickFormatter={(v: number) => `${v}%`} />
        <YAxis type="category" dataKey="name" width={110} {...axisProps}
               tick={{ fill: p.muted, fontSize: 11 }} />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, _n, item) =>
            `${Number(v).toFixed(1)}% of ${item?.payload?.total ?? 0}`
          }
        />
        <Bar dataKey="pct" name="Completed" fill={p.series2}
             radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Volume and speed on ONE plot, for the drill page.
 *
 * ⚠️ The console deliberately keeps these apart: with two y-axes the line's
 * position against the bars is arbitrary, so a combined chart implies a
 * relationship it cannot support. That reasoning still holds for the OVERVIEW,
 * where the reader is comparing periods against each other.
 *
 * Inside a drill the question is different — "what happened here, and did it
 * take longer than usual" — and the two series are being read against the same
 * narrow slice rather than against each other. So the axes are labelled, the
 * right-hand one is explicitly hours, and the legend names both. It is a
 * deliberate exception to the rule above, not an oversight of it.
 */
export function DrillMixedChart({
  data,
  bucket,
}: {
  data: MetricRow[];
  bucket: string;
}) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);

  if (data.length === 0) return <EmptyPlot note="No requests in this slice" />;

  const rows = data.map((m) => ({
    label: periodLabel(String(m.period), bucket),
    raised: Number(m.total),
    completed: Number(m.completed),
    hours: m.avg_hours_to_resolve === null ? null : Number(m.avg_hours_to_resolve),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis yAxisId="count" {...axisProps} allowDecimals={false} />
        <YAxis
          yAxisId="hours"
          orientation="right"
          {...axisProps}
          tickFormatter={(v: number) => `${v}h`}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, name) =>
            // A null hours value arrives as undefined here — an unresolved
            // period must read as "not timed", never as "0 h", which would
            // claim an instant resolution that never happened.
            name === "Avg. resolve"
              ? [v == null ? "not timed" : `${v} h`, String(name)]
              : [v == null ? "—" : v, String(name)]
          }
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="count" dataKey="raised" name="Raised" fill={p.series1} radius={[3, 3, 0, 0]} />
        <Bar yAxisId="count" dataKey="completed" name="Completed" fill={p.series2} radius={[3, 3, 0, 0]} />
        <Line
          yAxisId="hours"
          type="monotone"
          dataKey="hours"
          name="Avg. resolve"
          stroke={p.categorical[2]}
          strokeWidth={2}
          dot={{ r: 3 }}
          // A period in which nothing was resolved is a GAP, not a zero —
          // joining across it would draw a recovery that did not happen.
          connectNulls={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
