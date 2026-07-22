export type AuditEntry = {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
};

export const ACTION_STYLES: Record<string, string> = {
  "payment.status_change": "bg-emerald-100 text-emerald-700 ring-emerald-200",
  "ticket.status_change": "bg-sky-100 text-sky-700 ring-sky-200",
  "ticket.assignment": "bg-violet-100 text-violet-700 ring-violet-200",
  "sc_budget.status_change": "bg-indigo-100 text-indigo-700 ring-indigo-200",
  "payment_settings.update": "bg-amber-100 text-amber-700 ring-amber-200",
  "notification.attempt": "bg-teal-100 text-teal-700 ring-teal-200",
};

export const ENTITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "payments", label: "Payments" },
  { key: "tickets", label: "Tickets" },
  { key: "sc_budgets", label: "Budgets" },
  { key: "payment_settings", label: "Settings" },
  { key: "notifications", label: "Notifications" },
];

// Human-readable one-line summary of what changed.
export function summarizeChange(entry: AuditEntry): string {
  const before = entry.before_state ?? {};
  const after = entry.after_state ?? {};

  if (entry.action.endsWith("status_change")) {
    return `${before.status ?? "—"} → ${after.status ?? "—"}`;
  }

  if (entry.action === "notification.attempt") {
    const ch = after.channel ?? "?";
    const st = after.status ?? "?";
    return `${ch} · ${st}`;
  }

  if (entry.action === "ticket.assignment") {
    const v = after.assigned_vendor_id;
    const o = after.assigned_to_user_id;
    if (!v && !o) return "unassigned";
    return `assigned${v ? " to vendor" : ""}${o ? " to ops staff" : ""}`;
  }

  if (entry.action === "payment_settings.update") {
    const parts: string[] = [];
    if (after.min_performance_score != null)
      parts.push(`KPI gate: ${after.min_performance_score}`);
    if (after.approval_threshold_amount != null)
      parts.push(`approval limit: ₦${Number(after.approval_threshold_amount).toLocaleString()}`);
    return parts.join(" · ") || "updated";
  }

  // Fallback: list changed keys.
  const changed = Object.keys(after).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
  );
  return changed.length ? changed.join(", ") : "no field changes";
}

// Pinned locale/timezone — see the note in lib/ticket-format.ts.
export function formatAuditTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
