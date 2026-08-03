"use client";

import {
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { usePalette, chartChrome } from "../Charts";
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
  if (bucket === "week") return `${d.getUTCDate()} ${mon}`;
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
  if (bucket === "week") e.setUTCDate(e.getUTCDate() + 7);
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
 * Volume and speed on one plot.
 *
 * Two axes, deliberately: counts and hours share no scale, and forcing them onto
 * one makes a 4-hour average invisible beside a 400-ticket month. The right axis
 * is labelled in its own unit so nobody reads the line as a count.
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
  if (data.length === 0) return <EmptyPlot height={300} />;

  const rows = data.map((r) => ({
    label: periodLabel(r.period, bucket),
    total: Number(r.total),
    completed: Number(r.completed),
    hours: r.avg_hours_to_resolve === null ? null : Number(r.avg_hours_to_resolve),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" />
        <YAxis yAxisId="count" allowDecimals={false} {...axisProps} />
        <YAxis
          yAxisId="hours"
          orientation="right"
          {...axisProps}
          tickFormatter={(v: number) => `${v}h`}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, name) =>
            name === "Avg. resolve" ? `${Number(v).toFixed(1)} h` : Number(v).toLocaleString()
          }
        />
        <Legend wrapperStyle={{ fontSize: 12, color: p.muted }} />
        <Bar yAxisId="count" dataKey="total" name="Raised" fill={p.series1}
             radius={[4, 4, 0, 0]} maxBarSize={40} />
        <Bar yAxisId="count" dataKey="completed" name="Completed" fill={p.series2}
             radius={[4, 4, 0, 0]} maxBarSize={40} />
        {/* connectNulls={false}: a period with nothing timed leaves a GAP rather
            than a straight line drawn through it, which would read as a measured
            trend across months where nothing was measured at all. */}
        <Line yAxisId="hours" type="monotone" dataKey="hours" name="Avg. resolve"
              stroke={p.muted} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
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
