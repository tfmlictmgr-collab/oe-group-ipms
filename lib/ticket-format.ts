export type Ticket = {
  id: string;
  channel: string;
  message_text: string;
  category: string | null;
  urgency: string | null;
  summary: string | null;
  property_or_unit: string | null;
  requires_human_review: boolean;
  status: string;
  created_at: string;
};

export const URGENCY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-700 ring-red-200",
  high: "bg-orange-100 text-orange-700 ring-orange-200",
  normal: "bg-sky-100 text-sky-700 ring-sky-200",
  low: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

export const STATUS_STYLES: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  assigned: "bg-sky-100 text-sky-700 ring-sky-200",
  acknowledged: "bg-indigo-100 text-indigo-700 ring-indigo-200",
  in_progress: "bg-amber-100 text-amber-700 ring-amber-200",
  resolved: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  closed: "bg-neutral-100 text-neutral-500 ring-neutral-200",
};

export const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  portal: "Portal",
  email: "Email",
};

// Locale and timezone are pinned so server and client render identically
// (an unpinned toLocaleString causes a hydration mismatch). Lagos time is also
// the correct business clock for OE Group — see CLAUDE.md A2.5.
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
