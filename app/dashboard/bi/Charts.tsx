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
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { formatNaira } from "@/lib/currency";

// Validated categorical slots (blue, green) — pass CVD, normal-vision and
// contrast checks. Each has a light-surface and a dark-surface variant so the
// same series keeps its identity in both themes without losing contrast.
type Palette = {
  series1: string;
  series2: string;
  grid: string;
  axis: string;
  muted: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  cursor: string;
};

const PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    series1: "#2a78d6",
    series2: "#008300",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    muted: "#898781",
    tooltipBg: "#ffffff",
    tooltipBorder: "rgba(11,11,11,0.10)",
    tooltipText: "#1a1a1a",
    cursor: "rgba(11,11,11,0.04)",
  },
  dark: {
    series1: "#63a4ef",
    series2: "#4caf62",
    grid: "#2a2f3d",
    axis: "#3a4152",
    muted: "#9aa1b0",
    tooltipBg: "#161a24",
    tooltipBorder: "rgba(255,255,255,0.12)",
    tooltipText: "#e8eaf0",
    cursor: "rgba(255,255,255,0.06)",
  },
};

// Resolve the active palette on the client. Defaults to light until mounted so
// server and client markup agree (no hydration mismatch).
function usePalette() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === "dark" ? PALETTE.dark : PALETTE.light;
}

function chartChrome(p: Palette) {
  return {
    axisProps: {
      stroke: p.axis,
      tick: { fill: p.muted, fontSize: 12 },
      tickLine: false,
    },
    tooltipStyle: {
      contentStyle: {
        borderRadius: 8,
        border: `1px solid ${p.tooltipBorder}`,
        background: p.tooltipBg,
        color: p.tooltipText,
        fontSize: 12,
      },
      cursor: { fill: p.cursor },
    },
  };
}

export type NamedValue = { name: string; value: number };

/** Single-measure magnitude across categories → one series, no legend. */
export function CountBar({
  data,
  height = 240,
}: {
  data: NamedValue[];
  height?: number;
}) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  if (data.length === 0) {
    return <EmptyPlot />;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis dataKey="name" {...axisProps} interval={0} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} />
        <Bar dataKey="value" name="Count" fill={p.series1} radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Vendor composite scores — one series, 0–100 domain. */
export function ScoreBar({ data }: { data: NamedValue[] }) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  if (data.length === 0) return <EmptyPlot />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
      >
        <CartesianGrid stroke={p.grid} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} {...axisProps} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          {...axisProps}
          tick={{ fill: p.muted, fontSize: 11 }}
        />
        <Tooltip {...tooltipStyle} formatter={(v) => Number(v).toFixed(1)} />
        <Bar dataKey="value" name="Composite" radius={[0, 4, 4, 0]} maxBarSize={22}>
          {data.map((d) => (
            <Cell key={d.name} fill={p.series1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type BudgetRow = { name: string; budget: number; invoiced: number };

/** Two measures on one scale (both ₦) → grouped bars + legend. */
export function BudgetBar({ data }: { data: BudgetRow[] }) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  if (data.length === 0) return <EmptyPlot />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
        barGap={2}
      >
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis
          dataKey="name"
          {...axisProps}
          interval={0}
          tick={{ fill: p.muted, fontSize: 11 }}
          // Property names collide at narrow widths — truncate; the full name
          // is still available in the hover tooltip.
          tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
        />
        <YAxis
          {...axisProps}
          tickFormatter={(v: number) => `₦${(v / 1_000_000).toFixed(1)}M`}
        />
        <Tooltip {...tooltipStyle} formatter={(v) => formatNaira(Number(v))} />
        <Legend wrapperStyle={{ fontSize: 12, color: p.muted }} />
        <Bar dataKey="budget" name="Budget" fill={p.series1} radius={[4, 4, 0, 0]} maxBarSize={40} />
        <Bar dataKey="invoiced" name="Invoiced" fill={p.series2} radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EmptyPlot() {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      No data yet
    </div>
  );
}
