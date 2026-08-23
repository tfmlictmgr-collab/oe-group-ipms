import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { averageComposite, scoreBand } from "@/lib/vendor-score";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../RoleGate";
import { FM_PM } from "@/lib/roles";

type VendorRow = {
  id: string;
  name: string;
  service_category: string | null;
  status: string;
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
  // `executive` holds `vendors.read`. Scoring a vendor (`vendors.evaluate`) is
  // deliberately not theirs — an evaluation feeds the payment gate they sit on,
  // so writing one would let the same person set and clear their own bar.
  if (!roleAllowed(session.profile?.role, [
    "admin", ...FM_PM, "finance_approver", "executive",
  ])) {
    return <RoleGate title="Vendors" />;
  }

  // Reading the register is wider than adding to it: finance and an executive
  // see vendors, but creating a company is the same audience `vendors.write`
  // covers. RLS refuses the insert regardless — this only decides whether to
  // offer a button that would be refused.
  const canAddVendor = roleAllowed(session.profile?.role, ["admin", ...FM_PM]);

  const supabase = await createClient();
  // ⚠️ Scores come from `vendor_evaluation_tickets`, NOT an embedded
  // `vendor_evaluations(...)` join — the raw table's generated
  // `composite_score` zeroes whichever half of a dual-source pair a row does
  // not carry (0104), so the embedded version ranked every vendor on a number
  // that structurally undercounts them. Two queries rather than one embed,
  // because the corrected figure lives in a view PostgREST cannot embed
  // without a foreign key; grouped here instead.
  const [{ data }, { data: scored }] = await Promise.all([
    supabase.from("vendors").select("id, name, service_category, status").order("name"),
    supabase.from("vendor_evaluation_tickets").select("vendor_id, composite_score"),
  ]);

  const byVendor = new Map<string, { composite_score: number | string | null }[]>();
  for (const row of (scored as { vendor_id: string; composite_score: number | null }[]) ?? []) {
    const list = byVendor.get(row.vendor_id) ?? [];
    list.push({ composite_score: row.composite_score });
    byVendor.set(row.vendor_id, list);
  }

  const vendors = ((data as VendorRow[]) ?? [])
    .map((v) => {
      const evals = byVendor.get(v.id) ?? [];
      return {
        ...v,
        // Discards the nulls a still-half-evaluated job contributes, exactly
        // as the gate does — a pending half must count for nothing, not zero.
        avg: averageComposite(evals),
        count: evals.length,
      };
    })
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vendors"
        description="Ranked by composite performance score (weighted per AURA)."
        actions={
          canAddVendor ? (
            <Button asChild variant="brand">
              <Link href="/dashboard/vendors/new"><Plus /> Add Vendor</Link>
            </Button>
          ) : undefined
        }
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
