import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";

type Variant = NonNullable<BadgeProps["variant"]>;

// One place that maps every domain status/urgency to a theme-aware colour, so
// tickets, payments and urgencies read consistently in light and dark.
const VARIANT_BY_STATUS: Record<string, Variant> = {
  // ticket status
  open: "info",
  assigned: "info",
  acknowledged: "info",
  in_progress: "warning",
  resolved: "success",
  closed: "muted",
  // urgency
  critical: "destructive",
  high: "warning",
  normal: "info",
  low: "muted",
  // payment state machine
  pending_verification: "warning",
  verified: "info",
  pending_evaluation: "warning",
  recommended: "info",
  pending_approval: "warning",
  approved: "info",
  remitted: "success",
  rejected: "destructive",
  // service charge / generic
  paid: "success",
  part_paid: "warning",
  unpaid: "destructive",
  overdue: "destructive",
  draft: "muted",
  active: "success",
};

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string | null | undefined;
  label?: string;
  className?: string;
}) {
  const key = (status ?? "").toLowerCase();
  const variant = VARIANT_BY_STATUS[key] ?? "default";
  return (
    <Badge variant={variant} className={className}>
      {label ?? humanize(status ?? "unknown")}
    </Badge>
  );
}
