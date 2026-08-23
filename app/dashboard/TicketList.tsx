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
import { shortRef } from "@/lib/acknowledgement";
import type { RequestScope } from "./request-scope";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
] as const;

export default function TicketList({
  initialTickets,
  scope = "all",
  viewerId = null,
}: {
  initialTickets: Ticket[];
  scope?: RequestScope;
  viewerId?: string | null;
}) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [live, setLive] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  // The server query was scoped; the socket is not. A request dispatched to
  // somebody else still arrives here (RLS lets this manager read it — they
  // manage the property), and without this it would land on their "Assigned to
  // me" list and stay there until a refresh corrected it.
  //
  // ⚠️ Narrowing only, and only of rows RLS already released. This cannot show
  // anything `tickets_select` withheld.
  const belongsHere = useMemo(() => {
    if (scope !== "mine" || !viewerId) return () => true;
    return (t: Ticket) => t.assigned_to_user_id === viewerId;
  }, [scope, viewerId]);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("tickets-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tickets" },
        (payload) => {
          const next = payload.new as Ticket;
          if (!belongsHere(next)) return;
          setTickets((prev) =>
            prev.some((t) => t.id === next.id) ? prev : [next, ...prev]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tickets" },
        (payload) => {
          const next = payload.new as Ticket;
          setTickets((prev) => {
            const known = prev.some((t) => t.id === next.id);
            // Reassignment moves a request between desks in both directions:
            // one dispatched TO this person should appear without a refresh,
            // and one taken away from them should go.
            if (!belongsHere(next)) return known ? prev.filter((t) => t.id !== next.id) : prev;
            if (!known) return [next, ...prev];
            return prev.map((t) => (t.id === next.id ? next : t));
          });
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [belongsHere]);

  // Client-side narrowing only — RLS already scoped what arrived here, so a
  // filter can never widen visibility beyond the viewer's B7 row.
  const visible = useMemo(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    // A reference as people actually quote it: "#C1AF0AF7", "c1af0af7", or a
    // pasted full UUID with its dashes. Reduced to bare hex on both sides so
    // all three are one query.
    const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    return tickets.filter((t) => {
      if (filter !== "all" && t.status !== filter) return false;
      if (!q) return true;
      if (hex.length >= 4 && t.id.replace(/-/g, "").startsWith(hex)) return true;
      return (
        (t.summary ?? "").toLowerCase().includes(q) ||
        t.message_text.toLowerCase().includes(q) ||
        (t.property_or_unit ?? "").toLowerCase().includes(q) ||
        (t.category ?? "").toLowerCase().includes(q)
      );
    });
  }, [tickets, query, filter]);

  // ⚠️ The page holds only the most recent slice. A reference older than that
  // matches nothing locally, and "No matching requests" would then read as
  // "no such request" — a confident wrong answer to someone holding a real
  // reference from a months-old WhatsApp thread. So when the query LOOKS like
  // a reference and found nothing here, ask the database, which searches the
  // whole table under the same RLS.
  const [remote, setRemote] = useState<Ticket[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const hex = query.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    const looksLikeRef = hex.length >= 4 && query.trim().length <= 40;
    if (!looksLikeRef || visible.length > 0) {
      setRemote([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // Debounced: this runs per keystroke otherwise, and a reference is typed
    // one character at a time.
    const timer = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc("find_tickets_by_reference", { p_ref: hex });
      if (!cancelled) {
        setRemote((data as Ticket[]) ?? []);
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query, visible.length]);

  // Only ever shown when the loaded page had nothing — never merged into it,
  // so the count chips keep describing exactly what they describe.
  const found = visible.length > 0 ? visible : remote;
  const showingOlder = visible.length === 0 && remote.length > 0;

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
            placeholder="Search by reference or text…"
            aria-label="Search requests by reference, summary, property or category"
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

      {showingOlder && (
        <p className="text-xs text-muted-foreground">
          Found outside the most recent {tickets.length} — matched on reference.
        </p>
      )}

      {found.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={
            tickets.length === 0
              ? scope === "mine"
                ? "Nothing assigned to you"
                : "No requests yet"
              : searching
                ? "Searching…"
                : "No matching requests"
          }
          description={
            tickets.length === 0
              ? scope === "mine"
                ? "Nothing is dispatched to you right now. Switch to your properties above to see requests waiting to be picked up."
                : "New requests from WhatsApp, Telegram, or the portal form appear here instantly."
              : searching
                ? "Checking older requests for that reference."
                : "Try a different search term or status filter. A reference like C1AF0AF7 finds a request however old it is."
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {found.map((ticket) => (
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
                    {/* The reference the reporter was given. Shown because it
                        is what they quote back — a list that cannot be matched
                        by eye against a WhatsApp message is a list you have to
                        search blind. */}
                    <span className="font-mono font-medium text-foreground/70">
                      {shortRef(ticket.id)}
                    </span>
                    {" · "}
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
