"use client";

import * as React from "react";
import { Search, Inbox, Printer } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatNaira } from "@/lib/currency";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export type RegisterRow = {
  id: string;
  label: string;
  propertyName: string | null;
  unitLabel: string | null;
  tenantName: string | null;
  period: string | null;
  amount: number;
  amountPaid: number;
  pct: number | null;
  status: string;
  dueDate: string | null;
};

const GROUPS = {
  property: { label: "By property", of: (r: RegisterRow) => r.propertyName ?? "Unfiled property" },
  unit: { label: "By unit", of: (r: RegisterRow) => r.label },
  tenant: { label: "By tenant", of: (r: RegisterRow) => r.tenantName ?? "Unassigned" },
  none: { label: "Ungrouped", of: () => "" },
} as const;
type GroupKey = keyof typeof GROUPS;

/**
 * The service-charge register, grouped and printable per property, per unit or
 * per tenant.
 *
 * ⚠️ It was one flat table of every invoice the viewer could reach, and Print
 * printed all of it. Asked for directly: "can service charge statements be
 * viewed/printed per property/per unit/per tenant, instead of how it currently
 * is?" — because handing a landlord the whole org's charges to show them one
 * building is both useless and more disclosure than the question needed.
 *
 * Filtering is in the browser and that is safe here for the same reason it is
 * on the vendor register and was NOT on the approvals queue: the page fetches
 * the whole set the viewer is entitled to, with no cap, so nothing a filter
 * does can hide a charge that exists. What is on screen is what prints —
 * the print styles hide the controls, not the filtering.
 */
export default function StatementsRegister({ rows }: { rows: RegisterRow[] }) {
  const [group, setGroup] = React.useState<GroupKey>("property");
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [period, setPeriod] = React.useState("");

  const periods = React.useMemo(
    () => Array.from(new Set(rows.map((r) => r.period).filter(Boolean))).sort().reverse() as string[],
    [rows]
  );

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!status || r.status === status) &&
        (!period || r.period === period) &&
        (!q ||
          r.label.toLowerCase().includes(q) ||
          (r.propertyName ?? "").toLowerCase().includes(q) ||
          (r.tenantName ?? "").toLowerCase().includes(q))
    );
  }, [rows, query, status, period]);

  const grouped = React.useMemo(() => {
    const m = new Map<string, RegisterRow[]>();
    for (const r of shown) {
      const key = GROUPS[group].of(r);
      const list = m.get(key) ?? [];
      list.push(r);
      m.set(key, list);
    }
    return m;
  }, [shown, group]);

  const sum = (list: RegisterRow[], f: (r: RegisterRow) => number) =>
    list.reduce((a, r) => a + f(r), 0);
  const outstandingOf = (r: RegisterRow) => Math.max(0, r.amount - r.amountPaid);

  // What the printed page is a statement OF — so a sheet handed to a landlord
  // says on its face which slice it is, rather than looking like the whole book.
  const scope = [
    status && `status: ${status}`,
    period && `period ${period}`,
    query.trim() && `matching “${query.trim()}”`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <div className="flex gap-1" role="tablist" aria-label="How to group the register">
          {(Object.keys(GROUPS) as GroupKey[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === group}
              onClick={() => setGroup(k)}
              className={
                k === group
                  ? "rounded-full border border-transparent bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-[var(--brand-fg)]"
                  : "rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              }
            >
              {GROUPS[k].label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search property, unit or tenant…"
            aria-label="Search the service-charge register"
            className="pl-9"
          />
        </div>

        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label="Filter by billing period"
          className="h-9 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground"
        >
          <option value="">Every period</option>
          {periods.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
          className="h-9 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground"
        >
          <option value="">Every status</option>
          <option value="invoiced">Invoiced</option>
          <option value="part_paid">Part paid</option>
          <option value="paid">Paid</option>
        </select>

        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer className="size-4" /> Print this view
        </Button>

        {(query || status || period) && (
          <button
            type="button"
            onClick={() => { setQuery(""); setStatus(""); setPeriod(""); }}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Only on paper: says which slice this sheet is. */}
      {scope && (
        <p className="hidden text-sm print:block">Filtered to {scope}.</p>
      )}

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Inbox className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No invoice matches those filters</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Clear them to see all {rows.length}.
            </p>
          </CardContent>
        </Card>
      ) : (
        Array.from(grouped.entries()).map(([heading, list]) => (
          <Card key={heading || "all"} className="break-inside-avoid">
            {group !== "none" && (
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{heading}</CardTitle>
                <CardDescription className="tabular-nums">
                  {list.length} invoice{list.length === 1 ? "" : "s"} · billed{" "}
                  {formatNaira(sum(list, (r) => r.amount))} · outstanding{" "}
                  {formatNaira(sum(list, outstandingOf))}
                </CardDescription>
              </CardHeader>
            )}
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    {group !== "unit" && <TableHead>Property / Unit</TableHead>}
                    {group !== "tenant" && <TableHead>Tenant</TableHead>}
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((c) => (
                    <TableRow key={c.id}>
                      {group !== "unit" && (
                        <TableCell className="font-medium">{c.label}</TableCell>
                      )}
                      {group !== "tenant" && (
                        <TableCell className="text-muted-foreground">
                          {c.tenantName ?? "Unassigned"}
                        </TableCell>
                      )}
                      <TableCell className="text-muted-foreground">{c.period ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {c.pct != null ? `${Number(c.pct).toFixed(2)}%` : "—"}
                      </TableCell>
                      <TableCell><StatusBadge status={c.status} /></TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNaira(outstandingOf(c))}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatNaira(c.amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
