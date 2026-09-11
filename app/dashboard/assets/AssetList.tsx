"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ChevronRight, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { humanize } from "@/lib/asset-schema";

export type AssetRow = {
  id: string;
  asset_tag: string;
  name: string;
  category: string;
  status: string;
  condition: string;
  criticality: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  location_detail: string | null;
  next_service_due: string | null;
  certificate_expiry: string | null;
  insurance_expiry: string | null;
  compliance_required: boolean;
  properties: { name: string } | null;
};

const conditionVariant = (c: string) =>
  c === "new" || c === "good" ? "success" as const
  : c === "fair" ? "warning" as const
  : "destructive" as const;

const criticalityVariant = (c: string) =>
  c === "critical" ? "destructive" as const
  : c === "high" ? "warning" as const
  : c === "medium" ? "info" as const
  : "muted" as const;

const DAY = 86_400_000;

/** Soonest of the compliance/insurance expiries, and how urgent it is. */
function expiryState(a: AssetRow) {
  if (!a.compliance_required && !a.certificate_expiry && !a.insurance_expiry) return null;
  const dates = [a.certificate_expiry, a.insurance_expiry]
    .filter(Boolean)
    .map((d) => new Date(d as string).getTime());
  if (dates.length === 0) return { label: "No certificate", variant: "warning" as const, soon: true };
  const soonest = Math.min(...dates);
  const days = Math.round((soonest - Date.now()) / DAY);
  if (days < 0) return { label: "Expired", variant: "destructive" as const, soon: true };
  if (days <= 60) return { label: `Expires in ${days}d`, variant: "warning" as const, soon: true };
  return { label: "Valid", variant: "success" as const, soon: false };
}

export default function AssetList({ assets }: { assets: AssetRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: assets.length, critical: 0, expiring: 0 };
    for (const a of assets) {
      c[a.category] = (c[a.category] ?? 0) + 1;
      if (a.criticality === "critical") c.critical++;
      if (expiryState(a)?.soon) c.expiring++;
    }
    return c;
  }, [assets]);

  // Categories actually present, biggest first — no empty chips.
  const categoryChips = useMemo(
    () =>
      Object.entries(counts)
        .filter(([k]) => !["all", "critical", "expiring"].includes(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6),
    [counts]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (filter === "critical" && a.criticality !== "critical") return false;
      if (filter === "expiring" && !expiryState(a)?.soon) return false;
      if (!["all", "critical", "expiring"].includes(filter) && a.category !== filter) return false;
      if (!q) return true;
      return [a.asset_tag, a.name, a.manufacturer, a.model, a.serial_number, a.location_detail, a.properties?.name]
        .some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [assets, query, filter]);

  const chip = (key: string, label: string, n: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={cn(
        "flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        filter === key
          ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {label}
      <span className={cn("tabular-nums", filter === key ? "opacity-80" : "opacity-60")}>{n}</span>
    </button>
  );

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={<Package />}
        title="No assets registered yet"
        description="Download the template to prepare your register offline, import it in bulk, or add assets one at a time."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tag, name, make, model, serial…"
          aria-label="Search assets"
          className="pl-9"
        />
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {chip("all", "All", counts.all)}
        {counts.critical > 0 && chip("critical", "Critical", counts.critical)}
        {counts.expiring > 0 && chip("expiring", "⚠ Expiring", counts.expiring)}
        {categoryChips.map(([k, n]) => chip(k, humanize(k), n))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title="No matching assets"
          description="Try a different search term or filter."
        />
      ) : (
        <ul className="space-y-2.5">
          {visible.map((a) => {
            const exp = expiryState(a);
            return (
              <li key={a.id}>
                <Link
                  href={`/dashboard/assets/${a.id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{a.asset_tag}</span>
                      <span className="min-w-0 truncate font-medium">{a.name}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[a.manufacturer, a.model, a.serial_number && `SN ${a.serial_number}`]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {a.properties?.name}
                      {a.location_detail ? ` · ${a.location_detail}` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{humanize(a.category)}</Badge>
                      <Badge variant={conditionVariant(a.condition)}>{humanize(a.condition)}</Badge>
                      <Badge variant={criticalityVariant(a.criticality)}>{humanize(a.criticality)}</Badge>
                      {exp && <Badge variant={exp.variant}>{exp.label}</Badge>}
                    </div>
                  </div>
                  <ChevronRight className="size-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Showing {visible.length} of {assets.length} · you only see assets on properties you manage.
      </p>
    </div>
  );
}
