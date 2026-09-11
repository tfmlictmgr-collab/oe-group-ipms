"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Search, Inbox } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { scoreBand } from "@/lib/vendor-score";
import {
  VENDOR_SORTS, filterVendors, sortVendors,
  type VendorListRow, type VendorSortKey,
} from "@/lib/vendor-list";

function bandVariant(score: number) {
  if (score >= 85) return "success" as const;
  if (score >= 70) return "info" as const;
  if (score >= 55) return "warning" as const;
  return "destructive" as const;
}

export type { VendorListRow } from "@/lib/vendor-list";

/**
 * The vendor register, searchable and sortable.
 *
 * ⚠️ Filtering and sorting happen IN THE BROWSER here, and that is correct for
 * this list where it was wrong for the approvals queue. The difference is the
 * cap: that page fetched only the newest hundred rows, so a client sort
 * re-ordered an already-truncated set and "oldest first" could never return the
 * oldest row. This list is fetched WHOLE — the vendors query carries no limit —
 * so nothing a search does here can hide a vendor that exists. If a cap is ever
 * added to that query, this must move server-side with it.
 */
export default function VendorList({ vendors }: { vendors: VendorListRow[] }) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<VendorSortKey>("score_desc");

  const shown = React.useMemo(
    () => sortVendors(filterVendors(vendors, query), sort),
    [vendors, query, sort]
  );

  const unscored = vendors.filter((v) => v.avg == null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or trade…"
            aria-label="Search vendors by name or service category"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {shown.length} of {vendors.length}
            {unscored > 0 ? ` · ${unscored} not yet evaluated` : ""}
          </span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as VendorSortKey)}
            aria-label="Order the vendor list"
            className="h-9 flex-shrink-0 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            {(Object.keys(VENDOR_SORTS) as VendorSortKey[]).map((k) => (
              <option key={k} value={k}>{VENDOR_SORTS[k]}</option>
            ))}
          </select>
        </div>
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Inbox className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">
              No vendor matches &ldquo;{query}&rdquo;
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Search matches the company name and the trade. Clear the box to see
              all {vendors.length}.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((v) => {
            const band = v.avg != null ? scoreBand(v.avg) : null;
            return (
              <li key={v.id}>
                <Link
                  href={`/dashboard/vendors/${v.id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <span
                    title={
                      v.avg != null
                        ? `Ranked ${v.rank} of ${vendors.length} by score`
                        : "Not yet evaluated — no rank"
                    }
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                    style={{
                      background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                      color: "var(--brand)",
                    }}
                  >
                    {v.avg != null ? v.rank : "—"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{v.name}</p>
                    <p className="truncate text-xs capitalize text-muted-foreground">
                      {v.serviceCategory ?? "—"} · {v.count} evaluation
                      {v.count === 1 ? "" : "s"}
                    </p>
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-3">
                    {band && v.avg != null && (
                      <Badge variant={bandVariant(v.avg)} className="hidden sm:inline-flex">
                        {band.label}
                      </Badge>
                    )}
                    <span className="w-11 text-right text-lg font-semibold tabular-nums">
                      {v.avg != null ? v.avg.toFixed(1) : "—"}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
