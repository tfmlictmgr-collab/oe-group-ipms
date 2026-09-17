"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Printer, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The schedule's controls.
 *
 * ⚠️ Everything here writes to the URL and lets the SERVER re-query. It is not
 * a preference: grouping and sorting decide which rows are fetched and in what
 * order, and a control that only re-arranges what the server already chose is
 * the defect this build fixed on the approvals queue, where "Oldest first"
 * re-sorted the newest hundred and could never return the oldest row.
 *
 * It also means the view is a URL — bookmarkable, shareable, and the same thing
 * the Print and Download buttons act on, so what is on paper is what was on
 * screen.
 */
export default function ScheduleFilters({
  group,
  sort,
  q,
  from,
  to,
  status,
  groups,
  sorts,
  pinned,
}: {
  group: string;
  sort: string;
  q: string;
  from: string;
  to: string;
  status: string;
  groups: { key: string; label: string }[];
  sorts: { key: string; label: string }[];
  /** A single landlord / property / tenant the view is narrowed to. */
  pinned: { owner: string; property: string; tenant: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const [text, setText] = React.useState(q);

  const push = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    startTransition(() => {
      router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
    });
  };

  const setParam = (key: string, value: string) =>
    push((p) => (value ? p.set(key, value) : p.delete(key)));

  // Debounced so a search does not re-query the database on every keystroke,
  // and committed on Enter for someone who types faster than the delay.
  React.useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => setParam("q", text.trim()), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const pins = [
    { key: "owner", label: "Landlord", value: pinned.owner },
    { key: "property", label: "Property", value: pinned.property },
    { key: "tenant", label: "Tenant", value: pinned.tenant },
  ].filter((p) => p.value);

  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="How to group the schedule">
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={g.key === group}
              onClick={() => setParam("group", g.key)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                g.key === group
                  ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {g.label}
            </button>
          ))}
        </div>

        <select
          value={sort}
          onChange={(e) => setParam("sort", e.target.value)}
          aria-label="Order the schedule"
          className="h-9 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {sorts.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>

        <select
          value={status}
          onChange={(e) => setParam("status", e.target.value)}
          aria-label="Filter by tenancy status"
          className="h-9 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <option value="">Every status</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="expired">Expired</option>
          <option value="terminated">Terminated</option>
        </select>

        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search landlord, property, tenant or unit…"
          aria-label="Search the schedule"
          className="h-9 w-full sm:max-w-xs"
        />

        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer className="size-4" /> Print
        </Button>

        {pending && <span className="text-xs text-muted-foreground">updating…</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Term starts between</span>
        <input
          type="date" value={from} max={to || undefined}
          onChange={(e) => setParam("from", e.target.value)}
          aria-label="Tenancies starting on or after"
          className="h-9 rounded-md border border-input bg-card px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        />
        <span>and</span>
        <input
          type="date" value={to} min={from || undefined}
          onChange={(e) => setParam("to", e.target.value)}
          aria-label="Tenancies starting on or before"
          className="h-9 rounded-md border border-input bg-card px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        />

        {/* A view narrowed to one landlord, property or tenant says so and can
            be undone. Without this the only way back from a filtered report is
            to edit the address bar. */}
        {pins.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setParam(p.key, "")}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)] px-2.5 py-1 text-[var(--brand)]"
          >
            {p.label}: {p.value} <X className="size-3" />
          </button>
        ))}

        {(from || to || q || status || pins.length > 0) && (
          <button
            type="button"
            onClick={() =>
              push((p) => {
                ["from", "to", "q", "status", "owner", "property", "tenant"].forEach((k) => p.delete(k));
              })
            }
            className="rounded-md border border-border px-2 py-1 hover:bg-accent hover:text-foreground"
          >
            Clear all filters
          </button>
        )}
      </div>
    </div>
  );
}
