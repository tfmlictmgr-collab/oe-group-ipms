"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  type Ticket,
  URGENCY_STYLES,
  STATUS_STYLES,
  CHANNEL_LABELS,
  formatDateTime,
} from "@/lib/ticket-format";

export default function TicketList({
  initialTickets,
}: {
  initialTickets: Ticket[];
}) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [live, setLive] = useState(false);

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

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs text-neutral-500">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            live ? "bg-emerald-500" : "bg-neutral-300"
          }`}
        />
        {live ? "Live — updates in real time" : "Connecting…"}
      </div>

      {tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No requests yet. New requests from WhatsApp, Telegram, or the form
          appear here instantly.
        </div>
      ) : (
        <ul className="space-y-3">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/dashboard/tickets/${ticket.id}`}
                className="block rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-neutral-800">
                      {ticket.summary ?? ticket.message_text}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {CHANNEL_LABELS[ticket.channel] ?? ticket.channel}
                      {ticket.property_or_unit
                        ? ` · ${ticket.property_or_unit}`
                        : ""}{" "}
                      · {formatDateTime(ticket.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                    {ticket.urgency && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                          URGENCY_STYLES[ticket.urgency] ?? URGENCY_STYLES.normal
                        }`}
                      >
                        {ticket.urgency}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                        STATUS_STYLES[ticket.status] ?? STATUS_STYLES.open
                      }`}
                    >
                      {ticket.status.replace(/_/g, " ")}
                    </span>
                  </div>
                </div>
                {ticket.category && (
                  <span className="mt-2 inline-block rounded-md bg-neutral-100 px-2 py-0.5 text-xs capitalize text-neutral-600">
                    {ticket.category}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
