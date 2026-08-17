"use client";

import { Building, Home } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";

export type PropertyRow = {
  id: string;
  name: string;
  reference: string | null;
  address: string | null;
  unit_count: number;
  occupied_count: number;
  node_path: string | null;
};

/**
 * The three portfolio tiles, each opening onto the properties behind them.
 *
 * The occupancy tile is the one worth having: a single percentage across the
 * whole portfolio says nothing about WHERE the voids are, and the answer is
 * already in `property_summary` — occupancy per property, sorted worst-first
 * so the properties actually costing money surface at the top rather than
 * being buried alphabetically in the table below.
 *
 * No fetch: `props` is exactly what the server component already loaded.
 */
export default function PropertyStats({ props }: { props: PropertyRow[] }) {
  const drawer = useDrawer();

  const totalUnits = props.reduce((s, p) => s + Number(p.unit_count), 0);
  const occupied = props.reduce((s, p) => s + Number(p.occupied_count), 0);
  const vacant = totalUnits - occupied;

  const nameRecord = (p: PropertyRow): DrawerRecord => ({
    id: p.id,
    title: p.name,
    meta: [p.reference, p.node_path, p.address].filter(Boolean).join(" · ") || undefined,
    href: `/dashboard/properties/${p.id}`,
  });

  // Worst occupancy first — a property with no units at all is not a void, so
  // it sorts last rather than reading as 0%.
  const byOccupancy = [...props]
    .filter((p) => Number(p.unit_count) > 0)
    .sort(
      (a, b) =>
        Number(a.occupied_count) / Number(a.unit_count) -
        Number(b.occupied_count) / Number(b.unit_count)
    );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Properties" value={String(props.length)} icon={<Building />}
          onClick={() => drawer.open({
            eyebrow: "Portfolio", title: "Properties",
            scope: `${props.length} in your scope`,
            records: props.map(nameRecord),
            emptyLabel: "No properties in your scope.",
          })}
        />
        <StatCard
          label="Units" value={String(totalUnits)} icon={<Home />}
          onClick={() => drawer.open({
            eyebrow: "Portfolio", title: "Units",
            scope: `${totalUnits} across ${props.length} propert${props.length === 1 ? "y" : "ies"}`,
            facts: [
              ["Occupied", String(occupied)],
              ["Vacant", String(vacant)],
            ],
            records: props
              .filter((p) => Number(p.unit_count) > 0)
              .sort((a, b) => Number(b.unit_count) - Number(a.unit_count))
              .map((p) => ({
                ...nameRecord(p),
                meta: `${p.unit_count} unit${Number(p.unit_count) === 1 ? "" : "s"}`,
              })),
            emptyLabel: "No units recorded yet.",
          })}
        />
        <StatCard
          label="Occupied"
          value={totalUnits ? `${Math.round((occupied / totalUnits) * 100)}%` : "—"}
          onClick={() => drawer.open({
            eyebrow: "Portfolio", title: "Occupancy",
            scope: "Lowest first — where the voids are",
            facts: [
              ["Occupied", String(occupied)],
              ["Vacant", String(vacant)],
              ["Total units", String(totalUnits)],
            ],
            records: byOccupancy.map((p) => {
              const pct = Math.round((Number(p.occupied_count) / Number(p.unit_count)) * 100);
              return {
                ...nameRecord(p),
                meta: `${p.occupied_count} of ${p.unit_count} occupied`,
                tag: `${pct}%`,
                tone: pct >= 90 ? "success" : pct >= 60 ? "warning" : "destructive",
              };
            }),
            emptyLabel: "No units recorded yet.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
