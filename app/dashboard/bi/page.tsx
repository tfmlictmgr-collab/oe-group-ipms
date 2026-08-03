import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Inbox, CheckCircle2, TrendingUp, Wallet, Banknote, BarChart3, SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { StatCard } from "@/components/patterns/stat-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CountBar, ScoreBar, BudgetBar, type NamedValue, type BudgetRow } from "./Charts";
import { biScope } from "./scope";

function titleize(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-2">{children}</CardContent>
    </Card>
  );
}

export default async function BiDashboardPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const role = session.profile?.role;
  const scope = biScope(role);

  const hasAnyWidget =
    scope.requests || scope.vendorPerf || scope.collection || scope.liabilities || scope.budget;
  if (!hasAnyWidget) {
    return (
      <div className="space-y-6">
        <PageHeader title="Executive Dashboard" />
        <EmptyState
          icon={<BarChart3 />}
          title="Not available for your role"
          description={`The executive dashboard isn't available for the ${titleize(
            role ?? "current"
          )} role. Your requests and statements are available from the menu.`}
        />
      </div>
    );
  }

  const supabase = await createClient();

  // Aggregated in the DATABASE (0061), not by pulling whole tables and counting
  // here. Past PostgREST's 1000-row cap the old approach truncated silently and
  // the KPIs undercounted — and an executive reading a collection rate cannot
  // tell a truncated figure from a true one.
  //
  // Still RLS-scoped: the views are `security_invoker`, so an FM/PM sees only
  // their properties' figures exactly as before. The aggregation moved; the
  // access rules did not.
  const [statusRes, categoryRes, financialsRes, utilisationRes, scoresRes] =
    await Promise.all([
      supabase.from("bi_ticket_status").select("status, total"),
      supabase.from("bi_ticket_category").select("category, total"),
      supabase.from("bi_financials").select("*").maybeSingle(),
      supabase
        .from("bi_budget_utilisation")
        .select("budget_id, property_name, budgeted, invoiced")
        .order("budgeted", { ascending: false }),
      supabase.from("bi_vendor_scores").select("name, average_score"),
    ]);

  // ── Ops metrics ──────────────────────────────────────────────────────────
  const byStatus = new Map<string, number>(
    (statusRes.data ?? []).map((r) => [String(r.status), Number(r.total)])
  );
  const byCategory = new Map<string, number>(
    (categoryRes.data ?? [])
      .filter((r) => r.category !== "unclassified")
      .map((r) => [String(r.category), Number(r.total)])
  );
  const statusData: NamedValue[] = ["open", "in_progress", "resolved", "closed"]
    .filter((s) => byStatus.has(s))
    .map((s) => ({ name: titleize(s), value: byStatus.get(s) ?? 0 }));
  const categoryData: NamedValue[] = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: titleize(k), value: v }));

  const openCount = (byStatus.get("open") ?? 0) + (byStatus.get("in_progress") ?? 0);
  const closedCount = (byStatus.get("resolved") ?? 0) + (byStatus.get("closed") ?? 0);

  const vendorScores: NamedValue[] = (scoresRes.data ?? [])
    .map((v) => ({ name: String(v.name), value: Number(v.average_score) }))
    .filter((v) => v.value > 0)
    .sort((a, b) => b.value - a.value);

  // ── Financial metrics ────────────────────────────────────────────────────
  const fin = financialsRes.data as {
    total_invoiced: number | string;
    total_collected: number | string;
    vendor_liabilities: number | string;
  } | null;

  const totalInvoiced = Number(fin?.total_invoiced ?? 0);
  const totalPaid = Number(fin?.total_collected ?? 0);
  const outstanding = totalInvoiced - totalPaid;
  const collectionRate = totalInvoiced > 0 ? (totalPaid / totalInvoiced) * 100 : 0;
  const vendorLiabilities = Number(fin?.vendor_liabilities ?? 0);

  // Aggregated in the database (0074). This previously selected every invoice
  // row carrying a budget_id and summed them here, under a comment claiming it
  // was bounded by budget count — it was one row per INVOICE, so past
  // PostgREST's 1000-row cap the panel under-reported with nothing to show it.
  const budgetData: BudgetRow[] = (utilisationRes.data ?? []).map((b) => ({
    name: b.property_name ?? "—",
    budget: Number(b.budgeted),
    invoiced: Number(b.invoiced),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Executive Dashboard"
        description={`Live data, scoped to the ${titleize(role ?? "")} role.`}
        actions={
          scope.requests && (
            <Button asChild variant="outline">
              <Link href="/dashboard/bi/analytics">
                <SlidersHorizontal /> Analytics console
              </Link>
            </Button>
          )
        }
      />

      {/* KPI tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {scope.requests && (
          <>
            <StatCard
              label="Open requests"
              value={openCount}
              icon={<Inbox />}
              hint="open + in progress"
            />
            <StatCard
              label="Closed requests"
              value={closedCount}
              icon={<CheckCircle2 />}
              hint="resolved + closed"
            />
          </>
        )}
        {scope.collection && (
          <>
            <StatCard
              label="Collection rate"
              value={`${collectionRate.toFixed(1)}%`}
              icon={<TrendingUp />}
              hint={`${formatNaira(totalPaid)} of ${formatNaira(totalInvoiced)}`}
            />
            <StatCard
              label="Outstanding"
              value={formatNaira(outstanding)}
              icon={<Wallet />}
              hint="receivables"
            />
          </>
        )}
        {scope.liabilities && (
          <StatCard
            label="Vendor liabilities"
            value={formatNaira(vendorLiabilities)}
            icon={<Banknote />}
            hint="in-flight, not yet remitted"
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {scope.requests && (
          <>
            <Panel title="Requests by status">
              <CountBar data={statusData} />
            </Panel>
            <Panel title="Requests by category">
              <CountBar data={categoryData} />
            </Panel>
          </>
        )}
        {scope.vendorPerf && (
          <Panel
            title="Vendor performance"
            subtitle="Average composite score (AURA weighting), 0–100"
          >
            <ScoreBar data={vendorScores} />
          </Panel>
        )}
        {scope.budget && (
          <Panel
            title="Budget utilisation"
            subtitle="Annual budget vs. invoiced to date, per property"
          >
            <BudgetBar data={budgetData} />
          </Panel>
        )}
      </div>
    </div>
  );
}
