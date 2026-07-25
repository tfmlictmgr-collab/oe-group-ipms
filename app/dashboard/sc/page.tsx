import Link from "next/link";
import { redirect } from "next/navigation";
import { ReceiptText, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import RoleGate, { roleAllowed } from "../RoleGate";

type BudgetRow = {
  id: string;
  period: string;
  description: string | null;
  total_amount: number | string;
  status: string;
  properties: { name: string } | null;
};

export default async function ServiceChargePage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!roleAllowed(session.profile?.role, ["admin", "facility_manager", "finance_approver"])) {
    return <RoleGate title="Service Charge Administration" />;
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("sc_budgets")
    .select("id, period, description, total_amount, status, properties(name)")
    .order("period", { ascending: false });

  const budgets = (data as unknown as BudgetRow[]) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service Charge Administration"
        description="Annual budgets apportioned across each property's units."
      />

      {budgets.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title="No budgets yet"
          description="Create a budget for a property to apportion charges across its units."
        />
      ) : (
        <ul className="space-y-2.5">
          {budgets.map((b) => (
            <li key={b.id}>
              <Link
                href={`/dashboard/sc/${b.id}`}
                className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:border-[var(--brand)]/40 hover:shadow-md"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{b.properties?.name ?? "—"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {b.description} · {b.period}
                  </p>
                  <div className="mt-2 sm:hidden">
                    <StatusBadge status={b.status} />
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  <span className="hidden sm:inline-flex">
                    <StatusBadge status={b.status} />
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatNaira(b.total_amount)}
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
