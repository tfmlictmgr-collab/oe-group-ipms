"use client";

import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
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
export type Palette = {
  series1: string;
  series2: string;
  /**
   * Categorical hues in FIXED ORDER, for charts whose slices are identities
   * rather than measures (the category mix, for one).
   *
   * ⚠️ Assigned by position and never cycled: slot 3 is slot 3 whether or not
   * slots 1 and 2 are on screen, so filtering a category out cannot repaint the
   * survivors. Six is the ceiling here on purpose — past ~7 classes adjacent
   * hues blur and the honest answer is a table.
   *
   * Both rows are validated (not eyeballed) with the dataviz validator on the
   * adjacent pairlist, which is the right list for a ring or a stack:
   *   light — CVD ΔE 9.1, normal-vision 19.6, contrast WARN on three slots
   *   dark  — CVD ΔE 8.4, normal-vision 19.3, contrast all ≥ 3:1
   * The light WARN is why every categorical chart below carries visible labels:
   * relief is obligatory there, not a nicety.
   */
  categorical: string[];
  grid: string;
  axis: string;
  muted: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  cursor: string;
  /** The chart surface itself — the gap colour that separates adjoining fills. */
  surface: string;
};

const PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    series1: "#2a78d6",
    series2: "#008300",
    categorical: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    muted: "#898781",
    tooltipBg: "#ffffff",
    tooltipBorder: "rgba(11,11,11,0.10)",
    tooltipText: "#1a1a1a",
    cursor: "rgba(11,11,11,0.04)",
    surface: "#ffffff",
  },
  dark: {
    series1: "#63a4ef",
    series2: "#4caf62",
    categorical: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
    grid: "#2a2f3d",
    axis: "#3a4152",
    muted: "#9aa1b0",
    tooltipBg: "#161a24",
    tooltipBorder: "rgba(255,255,255,0.12)",
    tooltipText: "#e8eaf0",
    cursor: "rgba(255,255,255,0.06)",
    surface: "#161a24",
  },
};

// Resolve the active palette on the client. Defaults to light until mounted so
// server and client markup agree (no hydration mismatch).
export function usePalette() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === "dark" ? PALETTE.dark : PALETTE.light;
}

export function chartChrome(p: Palette) {
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

/**
 * Part-to-whole, at a glance — the mix, not the ranking.
 *
 * A ring is the right form for "what is this made of" and the wrong one for
 * "which is bigger": arc lengths of similar size are genuinely hard to compare,
 * so anything whose job is comparison stays a bar. Capped at six slices for the
 * same reason the palette is — past that, adjacent hues blur and a table is the
 * honest answer, so the remainder folds into one "Other" slice rather than
 * inventing a seventh colour.
 *
 * Identity is never colour-alone: each slice is directly labelled with its
 * share, and a legend names every one. That is also what discharges the light
 * palette's contrast WARN, where relief is obligatory rather than optional.
 */
export function MixDonut({
  data,
  height = 260,
  centreLabel,
  formatValue,
}: {
  data: NamedValue[];
  height?: number;
  /** What the hole is for: the total the slices add up to. */
  centreLabel?: string;
  formatValue?: (n: number) => string;
}) {
  const p = usePalette();
  const { tooltipStyle } = chartChrome(p);

  const cleaned = data.filter((d) => Number(d.value) > 0);
  if (cleaned.length === 0) return <EmptyPlot />;

  // Largest first, then everything past the fifth folded into one slice. The
  // fold happens BEFORE colours are handed out, so slot N is always the same
  // entity for a given dataset.
  const sorted = [...cleaned].sort((a, b) => Number(b.value) - Number(a.value));
  const head = sorted.slice(0, 5);
  const tail = sorted.slice(5);
  const rows = tail.length
    ? [...head, { name: "Other", value: tail.reduce((s, d) => s + Number(d.value), 0) }]
    : head;

  const total = rows.reduce((s, d) => s + Number(d.value), 0);
  const fmt = formatValue ?? ((n: number) => n.toLocaleString());

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="82%"
            // A 2px surface gap between adjoining fills, drawn in the surface
            // colour rather than as a stroke of the series hue.
            paddingAngle={1}
            stroke={p.surface}
            strokeWidth={2}
            // Selective direct labels: the share, on slices with room for it.
            // A number on every slice is noise; a number on none is a puzzle.
            label={({ percent }: { percent?: number }) =>
              percent && percent >= 0.08 ? `${Math.round(percent * 100)}%` : ""
            }
            labelLine={false}
            isAnimationActive={false}
          >
            {rows.map((d, i) => (
              <Cell
                key={d.name}
                fill={d.name === "Other" ? p.muted : p.categorical[i % p.categorical.length]}
              />
            ))}
          </Pie>
          <Tooltip
            {...tooltipStyle}
            formatter={(v, n) => [
              `${fmt(Number(v))} · ${total > 0 ? Math.round((Number(v) / total) * 100) : 0}%`,
              String(n ?? ""),
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: p.muted }} />
        </PieChart>
      </ResponsiveContainer>

      {/* The hole earns its keep: the total the ring is a breakdown OF. */}
      {centreLabel && (
        <div
          className="pointer-events-none absolute inset-x-0 flex flex-col items-center justify-center"
          style={{ top: 0, height: height - 32 }}
        >
          <span className="text-xl font-semibold tabular-nums">{fmt(total)}</span>
          <span className="text-[11px] text-muted-foreground">{centreLabel}</span>
        </div>
      )}
    </div>
  );
}

export type TrendPoint = { label: string; value: number | null };

/**
 * One measure over time, on ONE axis.
 *
 * Exists because the console's trend plot used to carry counts and hours
 * together on two y-scales. Two scales invent a correlation the data does not
 * contain — the alignment between them is arbitrary — and it is the single most
 * common charting mistake there is. Splitting them costs one more plot and
 * removes the false reading entirely.
 */
export function TrendLine({
  data,
  height = 240,
  unit,
  formatValue,
}: {
  data: TrendPoint[];
  height?: number;
  unit?: string;
  formatValue?: (n: number) => string;
}) {
  const p = usePalette();
  const { axisProps, tooltipStyle } = chartChrome(p);
  if (data.length === 0 || data.every((d) => d.value === null)) {
    return <EmptyPlot />;
  }
  const fmt = formatValue ?? ((n: number) => n.toLocaleString());

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={p.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" />
        <YAxis
          {...axisProps}
          tickFormatter={(v: number) => (unit ? `${v}${unit}` : fmt(v))}
        />
        <Tooltip {...tooltipStyle} formatter={(v) => (v === null ? "—" : fmt(Number(v)))} />
        {/* connectNulls={false}: an unmeasured period leaves a GAP rather than a
            line drawn straight through it, which would read as a measured trend
            across months where nothing was measured at all. */}
        <Line
          type="monotone"
          dataKey="value"
          name="Value"
          stroke={p.series1}
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: p.series1 }}
          activeDot={{ r: 5, stroke: p.surface, strokeWidth: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
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
