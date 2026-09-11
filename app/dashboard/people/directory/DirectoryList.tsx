"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export type DirectoryTag = { label: string; variant?: NonNullable<BadgeProps["variant"]> };

export type DirectoryRow = {
  key: string;
  /** Where the row opens. Every row has one — a directory entry that opens
      nothing is the inert card the board asked to be rid of on My Rent. */
  href: string;
  name: string;
  /** Contact line — email and phone, whichever exist. */
  contact?: string;
  /** What ties them to the organisation: their home, their buildings, their places. */
  detail?: string;
  tags: DirectoryTag[];
  inactive?: boolean;
};

/**
 * One group of the directory, searchable in place.
 *
 * Filtering happens in the browser because the server has already decided
 * which rows this viewer may see — the search narrows a list, it never widens
 * one — and a roster of a few hundred people is small enough that a round-trip
 * per keystroke would be slower than the list it filters.
 */
export default function DirectoryList({
  rows,
  noun,
  emptyHint,
}: {
  rows: DirectoryRow[];
  noun: string;
  emptyHint: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);

  const inactiveCount = rows.filter((r) => r.inactive).length;
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && r.inactive) return false;
      if (!q) return true;
      return [r.name, r.contact, r.detail, ...r.tags.map((t) => t.label)].some((v) =>
        (v ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, showInactive]);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyHint}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3" data-print="screen-only">
        <div className="relative w-full sm:w-auto sm:min-w-0 sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${noun} by name, email, phone, place…`}
            aria-label={`Search ${noun}`}
            className="pl-9"
          />
        </div>
        {inactiveCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Show deactivated ({inactiveCount})
          </label>
        )}
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {visible.length} of {rows.length - (showInactive ? 0 : inactiveCount)}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nobody here matches that search.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {visible.map((r) => (
            <li key={r.key}>
              <Link
                href={r.href}
                className={cn(
                  "group flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                  r.inactive && "opacity-60"
                )}
              >
                <span
                  aria-hidden
                  className="flex size-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  style={{
                    background: "color-mix(in srgb, var(--brand) 14%, transparent)",
                    color: "var(--brand)",
                  }}
                >
                  {initials(r.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium group-hover:underline">
                    {r.name}
                  </span>
                  {r.contact && (
                    <span className="block truncate text-xs text-muted-foreground">{r.contact}</span>
                  )}
                  {r.detail && (
                    <span className="block truncate text-xs text-muted-foreground">{r.detail}</span>
                  )}
                </span>
                <span className="hidden flex-shrink-0 flex-wrap justify-end gap-1.5 sm:flex">
                  {r.tags.map((t) => (
                    <Badge key={t.label} variant={t.variant ?? "outline"}>
                      {t.label}
                    </Badge>
                  ))}
                </span>
                <ChevronRight className="size-4 flex-shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function initials(name: string): string {
  // Letters and digits only, split on anything else — "O'Brien & Sons Ltd"
  // reads as OS, not O'.
  const parts = name.split(/[\s.,&'()\-/]+/).filter((w) => /[A-Za-z0-9À-ɏ]/.test(w));
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
