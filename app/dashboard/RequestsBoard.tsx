"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { type Ticket } from "@/lib/ticket-format";
import type { RequestScope } from "./request-scope";
import RequestStats from "./RequestStats";
import TicketList from "./TicketList";

/**
 * The one owner of "which requests am I looking at".
 *
 * ⚠️ WHY THIS EXISTS. The stat tiles and the list were rendered as siblings
 * from the server's copy of the same array, and then `TicketList` kept its own
 * `useState` and its own realtime subscription. From the first socket message
 * onward the two described different sets: a request arriving live moved the
 * list and not the tiles. That is the fault that was reported from the live
 * portal — "OPEN REQUESTS 1" above a list saying "All 0" — and no amount of
 * fixing either component separately can make two independent copies agree.
 *
 * One array, one subscription, both consumers reading it.
 */
export default function RequestsBoard({
  initialTickets,
  scope,
  viewerId,
  propertyIds,
  truncated,
  total,
}: {
  initialTickets: Ticket[];
  scope: RequestScope;
  viewerId: string | null;
  /** Resolved SERVER-side from `current_user_property_ids()`. The browser is
   *  told which places are yours; it never decides. */
  propertyIds: string[];
  truncated: boolean;
  total: number;
}) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [live, setLive] = useState(false);

  // A fresh array arrives on every render, and using it directly as a dependency
  // would tear down and rebuild the realtime channel each time — which is how a
  // socket ends up missing exactly the message it was opened for.
  const placesKey = propertyIds.join(",");

  /**
   * The socket is not scoped; the server query was. This applies the SAME rule
   * to what arrives, so the live view and the loaded view describe one set.
   *
   * ⚠️ Narrowing only, and only of rows RLS already released — this cannot show
   * anything `tickets_select` withheld.
   */
  const belongsHere = useMemo(() => {
    if (!viewerId) return () => true;
    if (scope === "mine") return (t: Ticket) => t.assigned_to_user_id === viewerId;
    if (scope === "raised") return (t: Ticket) => t.sender_id === viewerId;
    // The landing view. A NEW request is unassigned by definition, so under the
    // old "mine"-only rule it could never satisfy this and nothing ever appeared
    // live on the view an FM/PM actually sits on — the other half of "they only
    // see them in their notifications".
    if (scope === "desk") {
      const places = new Set(propertyIds);
      return (t: Ticket) =>
        t.assigned_to_user_id === viewerId ||
        t.sender_id === viewerId ||
        (t.property_id != null && places.has(t.property_id));
    }
    return () => true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, viewerId, placesKey]);

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

  // Server-rendered rows are the truth on first paint; a later navigation to a
  // different view must replace them rather than leave the previous view's set
  // sitting under new tabs.
  useEffect(() => {
    setTickets(initialTickets);
  }, [initialTickets]);

  return (
    <>
      <RequestStats tickets={tickets} truncated={truncated} total={total} />
      <TicketList tickets={tickets} live={live} scope={scope} />
    </>
  );
}
