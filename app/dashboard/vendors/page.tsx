import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { averageComposite, scoreBand } from "@/lib/vendor-score";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import RoleGate, { roleAllowed } from "../RoleGate";

type VendorRow = {
  id: string;
  name: string;
  service_category: string | null;
  status: string;
  vendor_evaluations: { composite_score: number | string | null }[];
};

// Semantic badge variant from the score, so bands read correctly in dark mode
// too (scoreBand's `style` is a light-only ring/bg class set).
function bandVariant(score: number) {
  if (score >= 85) return "success" as const;
  if (score >= 70) return "info" as const;
  if (score >= 55) return "warning" as const;
  return "destructive" as const;
}

export default async function VendorsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!roleAllowed(session.profile?.role, ["admin", "facility_manager", "finance_approver"])) {
    return <RoleGate title="Vendors" />;
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("vendors")
    .select("id, name, service_category, status, vendor_evaluations(composite_score)")
    .order("name");

  const vendors = ((data as VendorRow[]) ?? [])
    .map((v) => ({
      ...v,
      avg: averageComposite(v.vendor_evaluations),
      count: v.vendor_evaluations.length,
    }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Ranked by composite performance score (weighted per AURA)."
      />

      {vendors.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No vendors yet"
          description="Vendors you onboard will appear here with their performance ranking."
        />
      ) : (
        <ul className="space-y-2.5">
          {vendors.map((v, i) => {
            const band = v.avg != null ? scoreBand(v.avg) : null;
            return (
              <li key={v.id}>
                <Link
                  href={`/dashboard/vendors/${v.id}`}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
                >
                  <span
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                    style={{
                      background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                      color: "var(--brand)",
                    }}
                  >
                    {i + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{v.name}</p>
                    <p className="truncate text-xs capitalize text-muted-foreground">
                      {v.service_category ?? "—"} · {v.count} evaluation
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
