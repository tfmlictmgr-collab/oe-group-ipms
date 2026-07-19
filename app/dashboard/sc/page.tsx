import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/currency";

type BudgetRow = {
  id: string;
  period: string;
  description: string | null;
  total_amount: number | string;
  status: string;
  properties: { name: string } | null;
};

export default async function ServiceChargePage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sc_budgets")
    .select("id, period, description, total_amount, status, properties(name)")
    .order("period", { ascending: false });

  const budgets = (data as unknown as BudgetRow[]) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-800">
          Service Charge Administration
        </h1>
        <p className="text-sm text-neutral-500">
          Annual budgets apportioned across each property&apos;s units.
        </p>
      </div>

      {budgets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No budgets yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {budgets.map((b) => (
            <li key={b.id}>
              <Link
                href={`/dashboard/sc/${b.id}`}
                className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-neutral-800">
                    {b.properties?.name ?? "—"}
                  </p>
                  <p className="truncate text-xs text-neutral-500">
                    {b.description} · {b.period}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                      b.status === "invoiced"
                        ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
                        : "bg-neutral-100 text-neutral-600 ring-neutral-200"
                    }`}
                  >
                    {b.status}
                  </span>
                  <span className="font-semibold tabular-nums text-neutral-800">
                    {formatNaira(b.total_amount)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
