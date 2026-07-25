"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Inbox, Search, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/patterns/status-badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { type Ticket, CHANNEL_LABELS, formatDateTime } from "@/lib/ticket-format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
] as const;

export default function TicketList({
  initialTickets,
}: {
  initialTickets: Ticket[];
}) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [live, setLive] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("tickets-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tickets" },
        (payload) => {
          setTickets((prev) => {
            const next = payload.new as Ticket;
            if (prev.some((t) => t.id === next.id)) return prev;
            return [next, ...prev];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tickets" },
        (payload) => {
          setTickets((prev) =>
            prev.map((t) =>
              t.id === (payload.new as Ticket).id ? (payload.new as Ticket) : t
            )
          );
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Client-side narrowing only — RLS already scoped what arrived here, so a
  // filter can never widen visibility beyond the viewer's B7 row.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (filter !== "all" && t.status !== filter) return false;
      if (!q) return true;
      return (
        (t.summary ?? "").toLowerCase().includes(q) ||
        t.message_text.toLowerCase().includes(q) ||
        (t.property_or_unit ?? "").toLowerCase().includes(q) ||
        (t.category ?? "").toLowerCase().includes(q)
      );
    });
  }, [tickets, query, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tickets.length };
    for (const t of tickets) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tickets]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search requests…"
            aria-label="Search requests"
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              live ? "bg-success animate-pulse" : "bg-muted-foreground/40"
            )}
          />
          {live ? "Live" : "Connecting…"}
        </div>
      </div>

      {/* Status filter chips — horizontally scrollable on small screens. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={cn(
                "flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {f.label}
              <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-60")}>
                {counts[f.key] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={tickets.length === 0 ? "No requests yet" : "No matching requests"}
          description={
            tickets.length === 0
              ? "New requests from WhatsApp, Telegram, or the portal form appear here instantly."
              : "Try a different search term or status filter."
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {visible.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/dashboard/tickets/${ticket.id}`}
                className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate font-medium">
                      {ticket.summary ?? ticket.message_text}
                    </p>
                    {ticket.requires_human_review && (
                      <Badge variant="warning">Needs review</Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {CHANNEL_LABELS[ticket.channel] ?? ticket.channel}
                    {ticket.property_or_unit ? ` · ${ticket.property_or_unit}` : ""} ·{" "}
                    {formatDateTime(ticket.created_at)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={ticket.status} />
                    {ticket.urgency && <StatusBadge status={ticket.urgency} />}
                    {ticket.category && (
                      <Badge variant="outline" className="capitalize">
                        {ticket.category}
                      </Badge>
                    )}
                  </div>
                </div>
                <ChevronRight className="size-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
