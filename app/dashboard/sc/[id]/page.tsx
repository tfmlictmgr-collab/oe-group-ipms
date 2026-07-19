import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { apportion } from "@/lib/apportionment";
import { formatNaira } from "@/lib/currency";
import GenerateButton from "./GenerateButton";

export default async function BudgetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: budget } = await supabase
    .from("sc_budgets")
    .select("id, period, description, total_amount, status, property_id, properties(name, address)")
    .eq("id", id)
    .single();
  if (!budget) notFound();

  const property = budget.properties as unknown as {
    name: string;
    address: string | null;
  } | null;

  const { data: units } = await supabase
    .from("units")
    .select("id, label, apportionment_factor, occupant_user_id")
    .eq("property_id", budget.property_id)
    .order("label");

  const shares = apportion(
    Number(budget.total_amount),
    (units ?? []).map((u) => ({
      id: u.id,
      label: u.label,
      factor: Number(u.apportionment_factor),
      occupant_user_id: u.occupant_user_id,
    }))
  );
  const sharesTotal = shares.reduce((a, s) => a + s.amount, 0);

  const canManage =
    session.profile?.role === "admin" ||
    session.profile?.role === "finance_approver";

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/sc"
        className="mb-4 inline-block text-sm text-neutral-500 hover:text-neutral-800"
      >
        ← Back to budgets
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-neutral-800">
              {property?.name}
            </h1>
            <p className="text-sm text-neutral-500">
              {budget.description} · {budget.period}
            </p>
            {property?.address && (
              <p className="mt-1 text-xs text-neutral-400">{property.address}</p>
            )}
          </div>
          <div className="flex-shrink-0 sm:text-right">
            <div className="text-2xl font-bold tabular-nums text-neutral-800">
              {formatNaira(budget.total_amount)}
            </div>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                budget.status === "invoiced"
                  ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
                  : "bg-neutral-100 text-neutral-600 ring-neutral-200"
              }`}
            >
              {budget.status}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold text-neutral-700">
          Apportionment ({shares.length} units, pro-rata by floor area)
        </h2>
        {canManage && (
          <GenerateButton
            budgetId={budget.id}
            alreadyInvoiced={budget.status === "invoiced"}
          />
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-left text-xs text-neutral-400">
              <th className="px-4 py-2 font-medium">Unit</th>
              <th className="px-3 py-2 text-right font-medium">Factor</th>
              <th className="px-3 py-2 text-right font-medium">Share %</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.id} className="border-b border-neutral-50 last:border-0">
                <td className="px-4 py-2 text-neutral-700">{s.label}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {s.factor}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {(s.pct * 100).toFixed(2)}%
                </td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-neutral-800">
                  {formatNaira(s.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-200 font-semibold">
              <td className="px-4 py-2 text-neutral-700" colSpan={3}>
                Total
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-neutral-800">
                {formatNaira(sharesTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="mt-3 text-xs text-neutral-400">
        Apportionment reconciles to the budget total exactly. Generating invoices
        creates a per-unit charge on each occupant&apos;s statement.
      </p>
    </div>
  );
}
