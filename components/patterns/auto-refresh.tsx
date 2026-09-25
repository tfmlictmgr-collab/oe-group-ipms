"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The safety net under live updates: re-ask the server for this page when the
 * person comes back to the tab, and every `everyMs` while they are looking at it.
 *
 * ⚠️ WHY, when Realtime already pushes changes. Realtime is one dependency with
 * several ways to go quiet while still looking healthy — on 25 Sept 2026 the
 * board showed "Live" for hours while production's stream delivered nothing
 * (0302, lib/supabase/realtime). A request that nobody sees until they think to
 * reload is the failure a service desk cannot afford. This bounds it: at worst
 * the page is `everyMs` stale, and never stale at all the moment the tab is
 * looked at again.
 *
 * `router.refresh()` re-runs the same RLS-scoped server queries as the person
 * already signed in and keeps client state (open dialogs, typed text) intact.
 * It is skipped while the tab is hidden, so a forgotten background tab costs
 * nothing.
 */
export default function AutoRefresh({ everyMs = 30_000 }: { everyMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const onReturn = () => {
      if (visible()) router.refresh();
    };
    const timer = setInterval(() => {
      if (visible()) router.refresh();
    }, everyMs);

    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [router, everyMs]);

  return null;
}
