import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

function trendColorClass(direction?: "up" | "down" | "flat") {
  return direction === "up"
    ? "text-success"
    : direction === "down"
      ? "text-destructive"
      : "text-muted-foreground";
}

function StatCardBody({
  label,
  value,
  icon,
  hint,
  trend,
  openHint,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  /** Shown on hover only, for the clickable variant — "this opens something". */
  openHint?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          {openHint && (
            <span className="opacity-0 normal-case tracking-normal text-[var(--brand)] transition-opacity group-hover:opacity-100">
              Open ↗
            </span>
          )}
        </p>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        {(hint || trend) && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {trend && <span className={cn("font-medium", trendColorClass(trend.direction))}>{trend.value}</span>}
            {hint}
          </p>
        )}
      </div>
      {icon && (
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg [&_svg]:size-5"
          style={{ background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--brand)" }}
        >
          {icon}
        </div>
      )}
    </div>
  );
}

// KPI tile. Icon sits in a soft brand-tinted chip; optional trend/hint below.
//
// ⚠️ `onClick` is additive and every existing call site is unaffected by it —
// omitted, this renders exactly as it always has, a plain Card. Passed, the
// card becomes a button that opens onto the records behind the figure (the
// drawer pattern proven on the analytics console, Task 4) rather than being a
// number with nowhere to go. `Card` here is a plain div, not a Slot-based
// component, so the button nests inside it rather than replacing it.
export function StatCard({
  label,
  value,
  icon,
  hint,
  trend,
  className,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  className?: string;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <Card className={cn("group overflow-hidden p-0 transition-colors hover:bg-accent/40", className)}>
        <button
          type="button"
          onClick={onClick}
          className="w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/40 sm:p-5"
        >
          <StatCardBody label={label} value={value} icon={icon} hint={hint} trend={trend} openHint />
        </button>
      </Card>
    );
  }

  return (
    <Card className={cn("p-4 sm:p-5", className)}>
      <StatCardBody label={label} value={value} icon={icon} hint={hint} trend={trend} />
    </Card>
  );
}
