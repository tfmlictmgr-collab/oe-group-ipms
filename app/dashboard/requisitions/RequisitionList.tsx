"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, ReceiptText, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";

export type RequisitionRow = {
  id: string;
  reference: string;
  /** The short reference people quote, e.g. a payable ref. */
  ref: string;
  description: string | null;
  totalAmount: number;
  amountLabel: string;
  status: string;
  createdAt: string;
  createdLabel: string;
  /** Who it is waiting on, for the ones still moving. */
  waiting: string | null;
};

/**
 * The groups a raiser thinks in, mapped from the requisition's own status
 * (0170/0250b) — the same Open / In progress / Resolved shape the Requests
 * board uses, with the two outcomes a requisition has that a request does not.
 */
const GROUPS = [
  { key: "all", label: "All", statuses: null },
  { key: "open", label: "Awaiting approval", statuses: ["pending_approval"] },
  { key: "returned", label: "Returned to me", statuses: ["returned_for_correction"] },
  { key: "in_progress", label: "Approved, not yet paid", statuses: ["approved"] },
  { key: "resolved", label: "Paid", statuses: ["remitted"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];
type SortKey = "newest" | "oldest" | "amount_desc" | "amount_asc";

export default function RequisitionList({ rows }: { rows: RequisitionRow[] }) {
  const [group, setGroup] = useState<GroupKey>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of GROUPS) {
      c[g.key] = g.statuses ? rows.filter((r) => (g.statuses as readonly string[]).includes(r.status)).length : rows.length;
    }
    return c;
  }, [rows]);

  // Narrowing and ordering only — the server already scoped these to what the
  // caller raised, so nothing here can widen what they see.
  const visible = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group)!;
    const q = query.trim().toLowerCase();
    const matched = rows.filter((r) => {
      if (g.statuses && !(g.statuses as readonly string[]).includes(r.status)) return false;
      const day = r.createdAt.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!q) return true;
      return [r.reference, r.ref, r.description ?? "", r.amountLabel, r.status.replace(/_/g, " ")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    return [...matched].sort((a, b) => {
      if (sort === "amount_desc") return b.totalAmount - a.totalAmount || b.createdAt.localeCompare(a.createdAt);
      if (sort === "amount_asc") return a.totalAmount - b.totalAmount || b.createdAt.localeCompare(a.createdAt);
      if (sort === "oldest") return a.createdAt.localeCompare(b.createdAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [rows, group, query, sort, from, to]);

  const filtered = group !== "all" || query !== "" || sort !== "newest" || from !== "" || to !== "";

  return (
    <div className="space-y-4">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by reference, description or amount…"
          aria-label="Search requisitions"
          className="pl-9"
        />
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Requisition status">
        {GROUPS.map((g) => {
          const active = group === g.key;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setGroup(g.key)}
              className={cn(
                "flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {g.label}
              <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-60")}>{counts[g.key] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort requisitions"
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount_desc">Largest amount first</option>
            <option value="amount_asc">Smallest amount first</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Raised from
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Raised on or after"
          />
        </label>
        <label className="flex items-center gap-1.5">
          to
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Raised on or before"
          />
        </label>
        {filtered && (
          <button
            type="button"
            onClick={() => { setGroup("all"); setQuery(""); setSort("newest"); setFrom(""); setTo(""); }}
            className="font-medium underline-offset-2 hover:text-foreground hover:underline"
          >
            Reset
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title={rows.length === 0 ? "You have not raised a requisition yet" : "No matching requisitions"}
          description={
            rows.length === 0
              ? "When you raise one it appears here, with where it is in the approval chain."
              : "Try a different search, status or date range."
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {visible.map((r) => (
            <li key={r.id}>
              <Link
                href={`/dashboard/approvals/requisitions/${r.id}`}
                className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-medium">
                    {r.reference} — {r.amountLabel}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.ref} · raised {r.createdLabel}
                    {r.description ? ` · ${r.description.slice(0, 80)}` : ""}
                  </p>
                  {r.waiting && <p className="text-xs font-medium text-foreground">{r.waiting}</p>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <StatusBadge status={r.status} />
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
