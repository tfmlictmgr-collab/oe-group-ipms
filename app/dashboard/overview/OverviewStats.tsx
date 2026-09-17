"use client";

import { Building, Building2, Package, Gauge } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";

type Property = { id: string; name: string };
type Unit = { id: string; property_id: string | null };
type Asset = {
  id: string; category: string | null; status: string | null;
  criticality: string | null; property_id: string | null;
};
type Vendor = {
  id: string; name: string; service_category: string | null; approval_status: string | null;
};

/**
 * The read-only observer's four programme tiles.
 *
 * ⚠️ NO LINKS in any of these records, and that is the point rather than an
 * omission. A viewer is given ONE destination on purpose (nav-config's own
 * note: the operational screens read tables they have no policy on, so a
 * link would land them on an empty page that reads as a broken build). The
 * drawer therefore shows composition and nothing clickable — it deepens the
 * one page they have instead of hinting at pages they cannot open.
 *
 * No fetch: everything here is what the server component already loaded,
 * through the viewer-safe `*_overview` views.
 */
export default function OverviewStats({
  props,
  unitRows,
  assetRows,
  vendorRows,
}: {
  props: Property[];
  unitRows: Unit[];
  assetRows: Asset[];
  vendorRows: Vendor[];
}) {
  const drawer = useDrawer();

  const countBy = <T,>(rows: T[], key: (r: T) => string | null): DrawerRecord[] => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r) ?? "Unspecified";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    // Array.from, not spread — this codebase's tsconfig targets below es2015
    // for downlevel iteration, so spreading a Map iterator does not compile.
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        id: k,
        title: k.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        meta: String(v),
      }));
  };

  const unitsByProperty = new Map<string, number>();
  for (const u of unitRows) {
    if (!u.property_id) continue;
    unitsByProperty.set(u.property_id, (unitsByProperty.get(u.property_id) ?? 0) + 1);
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Properties" value={String(props.length)} icon={<Building />}
          onClick={() => drawer.open({
            eyebrow: "Programme", title: "Properties",
            scope: `${props.length} in the programme`,
            records: props.map((p) => ({
              id: p.id,
              title: p.name,
              meta: `${unitsByProperty.get(p.id) ?? 0} unit${(unitsByProperty.get(p.id) ?? 0) === 1 ? "" : "s"}`,
            })),
            emptyLabel: "No properties recorded.",
          })}
        />
        <StatCard
          label="Units" value={String(unitRows.length)} icon={<Building2 />}
          onClick={() => drawer.open({
            eyebrow: "Programme", title: "Units", scope: "By property, most first",
            facts: [["Total units", String(unitRows.length)]],
            records: props
              .map((p) => ({
                id: p.id, title: p.name, count: unitsByProperty.get(p.id) ?? 0,
              }))
              .filter((r) => r.count > 0)
              .sort((a, b) => b.count - a.count)
              .map((r) => ({ id: r.id, title: r.title, meta: String(r.count) })),
            emptyLabel: "No units recorded.",
          })}
        />
        <StatCard
          label="Assets on register" value={String(assetRows.length)} icon={<Package />}
          onClick={() => drawer.open({
            eyebrow: "Programme", title: "Assets on register", scope: "By category",
            facts: [["Total assets", String(assetRows.length)]],
            records: countBy(assetRows, (a) => a.category),
            emptyLabel: "No assets on the register.",
          })}
        />
        <StatCard
          label="Vendors" value={String(vendorRows.length)} icon={<Gauge />}
          onClick={() => drawer.open({
            eyebrow: "Programme", title: "Vendors", scope: "By service category",
            facts: [["Total vendors", String(vendorRows.length)]],
            records: countBy(vendorRows, (v) => v.service_category),
            emptyLabel: "No vendors recorded.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
