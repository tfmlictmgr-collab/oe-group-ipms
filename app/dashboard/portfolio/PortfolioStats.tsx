"use client";

import { Banknote, Wallet, PiggyBank } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { formatNaira } from "@/lib/currency";

export type StatementRow = {
  property_id: string;
  property_name: string;
  collected: number | string;
  fees: number | string;
  remitted: number | string;
  still_held: number | string;
};

/**
 * A landlord's four money tiles, each opening onto the per-property split
 * behind it.
 *
 * ⚠️ This is the one screen in this pass where the drawer earns its place
 * most plainly: every figure here is a SUM ACROSS PROPERTIES, and the
 * question an owner actually rings about — "which property is that from?" —
 * had no answer on screen without reading the statement table below and
 * doing the arithmetic themselves. The rows already exist in
 * `landlord_statement`; the drawer just stops hiding the split.
 *
 * No fetch: `statement` is exactly what the server component already loaded.
 */
export default function PortfolioStats({
  statement,
  from,
  to,
}: {
  statement: StatementRow[];
  from: string;
  to: string;
}) {
  const drawer = useDrawer();
  const period = `${from} to ${to}`;

  const sum = (k: keyof StatementRow) =>
    statement.reduce((a, r) => a + Number(r[k]), 0);

  const collected = sum("collected");
  const fees = sum("fees");
  const remitted = sum("remitted");
  const held = sum("still_held");

  /** Per-property rows for one column, largest first, zero-value rows dropped. */
  const rowsFor = (k: keyof StatementRow): DrawerRecord[] =>
    statement
      .map((r) => ({ r, v: Number(r[k]) }))
      .filter(({ v }) => v !== 0)
      .sort((a, b) => b.v - a.v)
      .map(({ r, v }) => ({
        id: `${r.property_id}:${String(k)}`,
        title: r.property_name,
        meta: formatNaira(v),
      }));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Rent collected" value={formatNaira(collected)} icon={<Banknote />}
          onClick={() => drawer.open({
            eyebrow: "My Portfolio", title: "Rent collected", scope: period,
            facts: [["Total", formatNaira(collected)]],
            records: rowsFor("collected"),
            emptyLabel: "Nothing collected in this period.",
          })}
        />
        <StatCard
          label="Management & admin fees" value={formatNaira(fees)} icon={<Wallet />}
          onClick={() => drawer.open({
            eyebrow: "My Portfolio", title: "Management & admin fees", scope: period,
            facts: [["Total", formatNaira(fees)]],
            records: rowsFor("fees"),
            emptyLabel: "No fees deducted in this period.",
          })}
        />
        <StatCard
          label="Remitted to you" value={formatNaira(remitted)} icon={<PiggyBank />}
          onClick={() => drawer.open({
            eyebrow: "My Portfolio", title: "Remitted to you", scope: period,
            facts: [["Total", formatNaira(remitted)]],
            records: rowsFor("remitted"),
            emptyLabel: "Nothing remitted in this period.",
          })}
        />
        <StatCard
          label="Held for you" value={formatNaira(held)} icon={<Wallet />}
          onClick={() => drawer.open({
            eyebrow: "My Portfolio", title: "Held for you", scope: period,
            facts: [["Total", formatNaira(held)]],
            records: rowsFor("still_held"),
            // The distinction the page's own comment already draws, restated
            // where someone is looking at an empty list wondering why.
            emptyLabel: "Nothing collected is still awaiting remittance. Rent not yet collected is not held for you.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
