"use client";

import { Home, Banknote, AlertTriangle } from "lucide-react";
import { StatCard } from "@/components/patterns/stat-card";
import { RecordDrawer, useDrawer, type DrawerRecord } from "@/components/patterns/record-drawer";
import { formatMoney } from "@/lib/currency";

export type RentRollRow = {
  lease_id: string;
  property_name: string;
  unit_label: string;
  tenant_name: string | null;
  status: string;
  end_date: string;
  days_to_expiry: number;
  rent_amount: number;
  currency: string;
  rent_outstanding: number;
};

/**
 * The four lettings tiles.
 *
 * Outstanding and Expiring are the two a manager acts on, and both were
 * dead ends: a total told you there was arrears somewhere, and a count told
 * you something expires soon, without saying WHICH tenancy in either case.
 * `rent_roll` already carries per-lease outstanding and days-to-expiry — the
 * drawer sorts by urgency so the tenancy needing a call today is first.
 *
 * No fetch: `rows` is exactly what the server component already loaded.
 */
export default function LeaseStats({ rows }: { rows: RentRollRow[] }) {
  const drawer = useDrawer();

  const live = rows.filter((r) => r.status === "active" || r.status === "renewed");
  const contracted = live.reduce((s, r) => s + Number(r.rent_amount), 0);
  const outstanding = rows.reduce((s, r) => s + Number(r.rent_outstanding), 0);
  const expiring = live.filter((r) => r.days_to_expiry >= 0 && r.days_to_expiry <= 90);
  const inArrears = rows.filter((r) => Number(r.rent_outstanding) > 0);

  const currency = rows[0]?.currency ?? "NGN";
  const naira = (n: number) => formatMoney(n, currency);

  const base = (r: RentRollRow): DrawerRecord => ({
    id: r.lease_id,
    title: `${r.property_name} · ${r.unit_label}`,
    meta: r.tenant_name ?? "no tenant recorded",
    href: `/dashboard/leases/${r.lease_id}`,
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active tenancies" value={String(live.length)} icon={<Home />}
          onClick={() => drawer.open({
            eyebrow: "Lettings", title: "Active tenancies",
            scope: `${live.length} active or renewed`,
            records: live.map((r) => ({ ...base(r), meta: `${r.tenant_name ?? "no tenant"} · ${naira(Number(r.rent_amount))}` })),
            emptyLabel: "No active tenancies.",
          })}
        />
        <StatCard
          label="Contracted rent" value={naira(contracted)} icon={<Banknote />}
          onClick={() => drawer.open({
            eyebrow: "Lettings", title: "Contracted rent",
            scope: "Across active and renewed tenancies, largest first",
            facts: [["Total", naira(contracted)]],
            records: [...live]
              .sort((a, b) => Number(b.rent_amount) - Number(a.rent_amount))
              .map((r) => ({ ...base(r), meta: naira(Number(r.rent_amount)) })),
            emptyLabel: "No active tenancies.",
          })}
        />
        <StatCard
          label="Outstanding" value={naira(outstanding)} icon={<AlertTriangle />}
          onClick={() => drawer.open({
            eyebrow: "Lettings", title: "Outstanding rent",
            scope: "Billed and not collected, largest first",
            facts: [["Total outstanding", naira(outstanding)]],
            records: [...inArrears]
              .sort((a, b) => Number(b.rent_outstanding) - Number(a.rent_outstanding))
              .map((r) => ({
                ...base(r),
                meta: `${r.tenant_name ?? "no tenant"} · ${naira(Number(r.rent_outstanding))} outstanding`,
                tone: "warning" as const,
              })),
            emptyLabel: "Nothing outstanding — every demand has been collected.",
          })}
        />
        <StatCard
          label="Expiring in 90 days" value={String(expiring.length)}
          onClick={() => drawer.open({
            eyebrow: "Lettings", title: "Expiring in 90 days",
            scope: "Soonest first — renewal notices go out at 90, 60 and 30 days",
            records: [...expiring]
              .sort((a, b) => a.days_to_expiry - b.days_to_expiry)
              .map((r) => ({
                ...base(r),
                meta: `${r.tenant_name ?? "no tenant"} · ends ${r.end_date}`,
                tag: r.days_to_expiry === 0 ? "today" : `${r.days_to_expiry}d`,
                tone: r.days_to_expiry <= 30 ? "destructive" : "warning",
              })),
            emptyLabel: "Nothing expiring in the next 90 days.",
          })}
        />
      </div>
      <RecordDrawer state={drawer.state} onClose={drawer.close} />
    </>
  );
}
