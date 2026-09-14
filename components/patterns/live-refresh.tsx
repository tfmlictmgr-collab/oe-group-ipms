"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Re-runs the server component when a request this person can see changes.
 *
 * ⚠️ WHY A REFRESH RATHER THAN A PATCHED ARRAY. The dashboard holds one list and
 * can splice a row into it (`RequestsBoard`). A vendor's My Work and an
 * operative's My Jobs cannot: those pages join tickets to payments, to
 * evaluation readiness and to invoice state, and a socket message carries only
 * the ticket. Splicing the row would show a new job beside stats, scores and
 * pay status computed before it existed — the same "two copies that disagree"
 * fault, arrived at from the other direction. Asking the server again keeps one
 * source of truth for the whole page.
 *
 * Reported from the live portal: a dispatched job reached the operative's
 * notifications and their job list did not move until they reloaded.
 *
 * 📌 This grants nothing. `router.refresh()` re-runs the same RLS-scoped
 * queries as the person already signed in, so an event for a row they cannot
 * read simply re-renders what they could already see.
 */
export default function LiveRefresh({ table = "tickets" }: { table?: string }) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();

    // Debounced: a dispatch writes the ticket and then its assignment, and a
    // refresh per statement would re-render the page two or three times for one
    // human action.
    const nudge = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => router.refresh(), 400);
    };

    const channel = supabase
      .channel(`live-refresh-${table}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table }, nudge)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table }, nudge)
      .subscribe();

    return () => {
      if (pending.current) clearTimeout(pending.current);
      supabase.removeChannel(channel);
    };
  }, [router, table]);

  return null;
}
