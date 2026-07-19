"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { formatNaira } from "@/lib/currency";

// Validated categorical slots (blue, green) — passes CVD, normal-vision and
// contrast checks against a white card surface. Chrome tokens per the dataviz
// reference palette.
const SERIES_1 = "#2a78d6";
const SERIES_2 = "#008300";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const MUTED = "#898781";

const axisProps = {
  stroke: AXIS,
  tick: { fill: MUTED, fontSize: 12 },
  tickLine: false,
} as const;

const tooltipStyle = {
  contentStyle: {
    borderRadius: 8,
    border: "1px solid rgba(11,11,11,0.10)",
    fontSize: 12,
  },
  cursor: { fill: "rgba(11,11,11,0.04)" },
} as const;

export type NamedValue = { name: string; value: number };

/** Single-measure magnitude across categories → one series, no legend. */
export function CountBar({
  data,
  height = 240,
}: {
  data: NamedValue[];
  height?: number;
}) {
  if (data.length === 0) {
    return <EmptyPlot />;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" {...axisProps} interval={0} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} />
        <Bar dataKey="value" name="Count" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Vendor composite scores — one series, 0–100 domain. */
export function ScoreBar({ data }: { data: NamedValue[] }) {
  if (data.length === 0) return <EmptyPlot />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
      >
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} {...axisProps} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          {...axisProps}
          tick={{ fill: MUTED, fontSize: 11 }}
        />
        <Tooltip {...tooltipStyle} formatter={(v) => Number(v).toFixed(1)} />
        <Bar dataKey="value" name="Composite" radius={[0, 4, 4, 0]} maxBarSize={22}>
          {data.map((d) => (
            <Cell key={d.name} fill={SERIES_1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type BudgetRow = { name: string; budget: number; invoiced: number };

/** Two measures on one scale (both ₦) → grouped bars + legend. */
export function BudgetBar({ data }: { data: BudgetRow[] }) {
  if (data.length === 0) return <EmptyPlot />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
        barGap={2}
      >
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="name"
          {...axisProps}
          interval={0}
          tick={{ fill: MUTED, fontSize: 11 }}
          // Property names collide at narrow widths — truncate; the full name
          // is still available in the hover tooltip.
          tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
        />
        <YAxis
          {...axisProps}
          tickFormatter={(v: number) => `₦${(v / 1_000_000).toFixed(1)}M`}
        />
        <Tooltip {...tooltipStyle} formatter={(v) => formatNaira(Number(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="budget" name="Budget" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={40} />
        <Bar dataKey="invoiced" name="Invoiced" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EmptyPlot() {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-400">
      No data yet
    </div>
  );
}
