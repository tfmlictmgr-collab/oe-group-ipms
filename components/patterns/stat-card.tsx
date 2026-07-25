import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

// KPI tile. Icon sits in a soft brand-tinted chip; optional trend/hint below.
export function StatCard({
  label,
  value,
  icon,
  hint,
  trend,
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  className?: string;
}) {
  const trendColor =
    trend?.direction === "up"
      ? "text-success"
      : trend?.direction === "down"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <Card className={cn("p-4 sm:p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          {(hint || trend) && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {trend && (
                <span className={cn("font-medium", trendColor)}>{trend.value}</span>
              )}
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
    </Card>
  );
}
