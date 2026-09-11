"use client";

import { Inbox, CheckCircle2, TrendingUp, Wallet, Banknote } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { formatNaira } from "@/lib/currency";
import type { NamedValue } from "./Charts";

/**
 * The executive KPI tiles.
 *
 * ⚠️ These behave DIFFERENTLY from every other drawer in this pass, on
 * purpose. Elsewhere the tile counts rows the page already holds, so the
 * drawer lists them. Here the figures come from aggregated database views
 * (`bi_ticket_status`, `bi_financials`, 0061/0074) — deliberately, because
 * counting in the page truncated silently past PostgREST's 1000-row cap and
 * an executive cannot tell a truncated collection rate from a true one.
 *
 * So the underlying rows are NOT on this page and listing them would need a
 * fetch. Rather than break the no-fetch rule (or worse, quietly show a
 * bounded sample of an unbounded figure), the drawer shows the COMPOSITION
 * of each number from the aggregates that are here — the arithmetic behind
 * the KPI, not a sample of its rows. Anyone wanting the rows themselves has
 * the Analytics console, which is built for exactly that and re-checks scope
 * per drill target.
 */
export default function BiStats({
  scope,
  statusData,
  categoryData,
  openCount,
  closedCount,
  collectionRate,
  totalPaid,
  totalInvoiced,
  outstanding,
  vendorLiabilities,
}: {
  scope: { requests: boolean; collection: boolean; liabilities: boolean };
  statusData: NamedValue[];
  categoryData: NamedValue[];
  openCount: number;
  closedCount: number;
  collectionRate: number;
  totalPaid: number;
  totalInvoiced: number;
  outstanding: number;
  vendorLiabilities: number;
}) {
  const drawer = useDrawer();

  const statusRecords = (names: string[]): DrawerRecord[] =>
    statusData
      .filter((s) => names.includes(s.name))
      .map((s) => ({ id: s.name, title: s.name, meta: s.value.toLocaleString() }));

  const categoryRecords: DrawerRecord[] = categoryData.map((c) => ({
    id: c.name,
    title: c.name,
    meta: c.value.toLocaleString(),
  }));

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {scope.requests && (
          <>
            <StatCard
              label="Open requests" value={openCount} icon={<Inbox />} hint="open + in progress"
              onClick={() => drawer.open({
                eyebrow: "Executive", title: "Open requests",
                scope: "Open and in-progress, by status then classification",
                facts: [["Open + in progress", openCount.toLocaleString()]],
                records: [...statusRecords(["Open", "In Progress"]), ...categoryRecords],
                emptyLabel: "Nothing open.",
              })}
            />
            <StatCard
              label="Closed requests" value={closedCount} icon={<CheckCircle2 />} hint="resolved + closed"
              onClick={() => drawer.open({
                eyebrow: "Executive", title: "Closed requests",
                scope: "Resolved and closed",
                facts: [["Resolved + closed", closedCount.toLocaleString()]],
                records: statusRecords(["Resolved", "Closed"]),
                emptyLabel: "Nothing closed yet.",
              })}
            />
          </>
        )}
        {scope.collection && (
          <>
            <StatCard
              label="Collection rate" value={`${collectionRate.toFixed(1)}%`} icon={<TrendingUp />}
              hint={`${formatNaira(totalPaid)} of ${formatNaira(totalInvoiced)}`}
              onClick={() => drawer.open({
                eyebrow: "Executive", title: "Collection rate",
                scope: "What has been collected against what was invoiced",
                facts: [
                  ["Invoiced", formatNaira(totalInvoiced)],
                  ["Collected", formatNaira(totalPaid)],
                  ["Outstanding", formatNaira(outstanding)],
                  ["Rate", `${collectionRate.toFixed(1)}%`],
                ],
                records: [],
                emptyLabel: "Open the Analytics console to see the invoices behind this.",
              })}
            />
            <StatCard
              label="Outstanding" value={formatNaira(outstanding)} icon={<Wallet />} hint="receivables"
              onClick={() => drawer.open({
                eyebrow: "Executive", title: "Outstanding receivables",
                scope: "Invoiced and not yet collected",
                facts: [
                  ["Invoiced", formatNaira(totalInvoiced)],
                  ["Collected", formatNaira(totalPaid)],
                  ["Outstanding", formatNaira(outstanding)],
                ],
                records: [],
                emptyLabel: "Open the Analytics console to see the invoices behind this.",
              })}
            />
          </>
        )}
        {scope.liabilities && (
          <StatCard
            label="Vendor liabilities" value={formatNaira(vendorLiabilities)} icon={<Banknote />}
            hint="in-flight, not yet remitted"
            onClick={() => drawer.open({
              eyebrow: "Executive", title: "Vendor liabilities",
              scope: "Approved and in-flight, not yet remitted",
              facts: [["In flight", formatNaira(vendorLiabilities)]],
              records: [],
              emptyLabel: "Approvals shows each payment and the stage it has reached.",
            })}
          />
        )}
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
