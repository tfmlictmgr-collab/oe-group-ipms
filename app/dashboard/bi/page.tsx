import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/currency";
import { averageComposite } from "@/lib/vendor-score";
import { CountBar, ScoreBar, BudgetBar, type NamedValue, type BudgetRow } from "./Charts";

// B7 "Exec / BI dashboard" column:
//   Admin → all · Facility Manager → ops KPIs · Finance/Approver → financial
//   Property Owner → own portfolio · Tenant / Vendor / FM Ops Staff → no access
function biScope(role: string | undefined) {
  switch (role) {
    case "admin":
      return { ops: true, financial: true, portfolio: true };
    case "facility_manager":
      return { ops: true, financial: false, portfolio: false };
    case "finance_approver":
      return { ops: false, financial: true, portfolio: false };
    case "property_owner":
      return { ops: false, financial: false, portfolio: true };
    default:
      return { ops: false, financial: false, portfolio: false };
  }
}

function titleize(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-400">{hint}</div>}
    </div>
  );
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
    <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <h2 className="text-sm font-semibold text-neutral-800">{title}</h2>
      {subtitle && <p className="mb-2 text-xs text-neutral-500">{subtitle}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default async function BiDashboardPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const role = session.profile?.role;
  const scope = biScope(role);

  if (!scope.ops && !scope.financial && !scope.portfolio) {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold text-neutral-800">
          Executive Dashboard
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          The executive dashboard isn&apos;t available for the{" "}
          <span className="capitalize">{titleize(role ?? "current")}</span> role.
          Your requests and statements are available from the menu above.
        </p>
      </div>
    );
  }

  const supabase = await createClient();

  // Every query below is RLS-scoped to the caller, so a role can never read
  // beyond its matrix row even though the widget set is also gated in the UI.
  const [ticketsRes, chargesRes, paymentsRes, budgetsRes, vendorsRes] =
    await Promise.all([
      supabase.from("tickets").select("status, category"),
      supabase.from("service_charges").select("amount, status, budget_id"),
      supabase.from("payments").select("amount, status"),
      supabase.from("sc_budgets").select("id, total_amount, properties(name)"),
      supabase.from("vendors").select("name, vendor_evaluations(composite_score)"),
    ]);

  const tickets = ticketsRes.data ?? [];
  const charges = chargesRes.data ?? [];
  const payments = paymentsRes.data ?? [];
  const budgets = (budgetsRes.data ?? []) as unknown as {
    id: string;
    total_amount: number | string;
    properties: { name: string } | null;
  }[];
  const vendors = (vendorsRes.data ?? []) as unknown as {
    name: string;
    vendor_evaluations: { composite_score: number | string | null }[];
  }[];

  // ── Ops metrics ──────────────────────────────────────────────────────────
  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const t of tickets) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    if (t.category)
      byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
  }
  const statusData: NamedValue[] = ["open", "in_progress", "resolved", "closed"]
    .filter((s) => byStatus.has(s))
    .map((s) => ({ name: titleize(s), value: byStatus.get(s) ?? 0 }));
  const categoryData: NamedValue[] = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: titleize(k), value: v }));

  const openCount = (byStatus.get("open") ?? 0) + (byStatus.get("in_progress") ?? 0);
  const closedCount = (byStatus.get("resolved") ?? 0) + (byStatus.get("closed") ?? 0);

  const vendorScores: NamedValue[] = vendors
    .map((v) => ({
      name: v.name,
      value: averageComposite(v.vendor_evaluations) ?? 0,
    }))
    .filter((v) => v.value > 0)
    .sort((a, b) => b.value - a.value);

  // ── Financial metrics ────────────────────────────────────────────────────
  const totalInvoiced = charges.reduce((a, c) => a + Number(c.amount), 0);
  const totalPaid = charges
    .filter((c) => c.status === "paid")
    .reduce((a, c) => a + Number(c.amount), 0);
  const outstanding = totalInvoiced - totalPaid;
  const collectionRate = totalInvoiced > 0 ? (totalPaid / totalInvoiced) * 100 : 0;

  // Liabilities = approved/in-flight vendor invoices not yet remitted.
  const vendorLiabilities = payments
    .filter((p) => !["remitted", "rejected"].includes(p.status))
    .reduce((a, p) => a + Number(p.amount), 0);

  const invoicedByBudget = new Map<string, number>();
  for (const c of charges) {
    if (!c.budget_id) continue;
    invoicedByBudget.set(
      c.budget_id,
      (invoicedByBudget.get(c.budget_id) ?? 0) + Number(c.amount)
    );
  }
  const budgetData: BudgetRow[] = budgets.map((b) => ({
    name: b.properties?.name ?? "—",
    budget: Number(b.total_amount),
    invoiced: invoicedByBudget.get(b.id) ?? 0,
  }));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-800">
          Executive Dashboard
        </h1>
        <p className="text-sm text-neutral-500">
          Live from Supabase · scoped to the{" "}
          <span className="capitalize">{titleize(role ?? "")}</span> role.
        </p>
      </div>

      {/* KPI tiles */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {scope.ops && (
          <>
            <StatTile label="Open requests" value={String(openCount)} hint="open + in progress" />
            <StatTile label="Closed requests" value={String(closedCount)} hint="resolved + closed" />
          </>
        )}
        {scope.financial && (
          <>
            <StatTile
              label="Collection rate"
              value={`${collectionRate.toFixed(1)}%`}
              hint={`${formatNaira(totalPaid)} of ${formatNaira(totalInvoiced)}`}
            />
            <StatTile label="Outstanding receivables" value={formatNaira(outstanding)} />
            <StatTile
              label="Vendor liabilities"
              value={formatNaira(vendorLiabilities)}
              hint="approved / in-flight, not yet remitted"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {scope.ops && (
          <>
            <Panel title="Requests by status">
              <CountBar data={statusData} />
            </Panel>
            <Panel title="Requests by category">
              <CountBar data={categoryData} />
            </Panel>
            <Panel
              title="Vendor performance"
              subtitle="Average composite score (AURA weighting), 0–100"
            >
              <ScoreBar data={vendorScores} />
            </Panel>
          </>
        )}

        {scope.financial && (
          <Panel
            title="Budget utilisation"
            subtitle="Annual budget vs. invoiced to date, per property"
          >
            <BudgetBar data={budgetData} />
          </Panel>
        )}
      </div>

      {scope.portfolio && !scope.financial && (
        <div className="mt-4 rounded-xl border border-dashed border-neutral-300 bg-white/60 p-6 text-sm text-neutral-500">
          <p className="font-medium text-neutral-700">Portfolio view</p>
          <p className="mt-1">
            Owner-scoped portfolio reporting requires the property-ownership
            mapping, which is not in the schema yet (owners are not currently
            linked to properties). Tracked as a known gap — see the Week 1
            checkpoint.
          </p>
        </div>
      )}
    </div>
  );
}
