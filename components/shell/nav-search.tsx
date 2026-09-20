"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchDestinations, type NavContext, type NavHit } from "./nav-config";

// The navigation search box.
//
// Built after Collections could not be found: it lives at
// `/dashboard/ledger/collections`, is a tab inside Client Funds, and appears in
// no sidebar. A search that covered only the sidebar would not have helped, so
// it searches the tab strips too — see `NavChild` in nav-config.
//
// ⚠️ It searches `searchDestinations(ctx, q)`, which applies `show(ctx)` BEFORE
// matching. Nothing this role cannot reach is ever a candidate, so nothing can
// be offered by mistake or inferred from a gap in the results. On a two-brand
// system that matters twice over: a TFML user typing "OEA" learns nothing (B1).
//
// This is presentation. Every page re-checks server-side.
export function NavSearch({
  ctx,
  onNavigate,
}: {
  ctx: NavContext;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchDestinations(ctx, q), [ctx, q]);

  // Ctrl-K / ⌘-K focuses the box from anywhere. Deliberately focus-and-select
  // rather than opening a modal: the box is already on screen, and a palette
  // that covers the page is a second way to navigate rather than a faster one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A cursor left pointing past the end of a shorter result list would send
  // Enter to nothing, or to the wrong row.
  useEffect(() => setCursor(0), [q]);

  // Enter has no anchor to click, so it navigates through the router — a client
  // transition, the same as clicking the row. `window.location.assign` would
  // have worked and would have reloaded the whole shell to move one tab.
  const go = (hit: NavHit | undefined) => {
    if (!hit) return;
    setQ("");
    onNavigate?.();
    router.push(hit.href);
  };

  return (
    <div className="px-3 pt-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-muted" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setQ(""); inputRef.current?.blur(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); go(hits[cursor]); }
          }}
          placeholder="Search menu…"
          aria-label="Search the menu"
          aria-controls="nav-search-results"
          className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-sm text-sidebar-foreground placeholder:text-sidebar-muted focus:border-white/25 focus:bg-white/10 focus:outline-none"
        />
      </div>

      {q.trim() !== "" && (
        <div id="nav-search-results" className="mt-2 space-y-0.5" role="listbox">
          {hits.length === 0 ? (
            // Says only that nothing here matches — never that something exists
            // elsewhere, which would be the leak this design exists to avoid.
            <p className="px-2 py-2 text-xs text-sidebar-muted">
              Nothing in your menu matches “{q.trim()}”.
            </p>
          ) : (
            hits.slice(0, 8).map((hit, i) => {
              const Icon = hit.icon;
              return (
                <Link
                  key={`${hit.href}-${hit.label}`}
                  href={hit.href}
                  role="option"
                  aria-selected={i === cursor}
                  onClick={() => { setQ(""); onNavigate?.(); }}
                  onMouseEnter={() => setCursor(i)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    i === cursor
                      ? "bg-white/10 text-white"
                      : "text-sidebar-foreground hover:bg-white/5"
                  )}
                >
                  <Icon className="size-3.5 shrink-0 text-sidebar-muted" />
                  <span className="min-w-0 flex-1 truncate">
                    {hit.context.endsWith("›") && (
                      <span className="text-sidebar-muted">{hit.context} </span>
                    )}
                    {hit.label}
                  </span>
                  {i === cursor && (
                    <CornerDownLeft className="size-3 shrink-0 text-sidebar-muted" />
                  )}
                </Link>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
