import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";

type Charge = {
  id: string;
  property_or_unit: string | null;
  billing_period: string | null;
  amount: number | string;
  apportionment_pct: number | string | null;
  status: string;
  due_date: string | null;
};

export default async function StatementsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const isStaff = ["admin", "facility_manager", "finance_approver"].includes(
    session.profile?.role ?? ""
  );

  const supabase = await createClient();
  const { data } = await supabase
    .from("service_charges")
    .select(
      "id, property_or_unit, billing_period, amount, apportionment_pct, status, due_date"
    )
    .order("billing_period", { ascending: false });

  const charges = (data as Charge[]) ?? [];
  const total = charges.reduce((a, c) => a + Number(c.amount), 0);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-800">
          {isStaff ? "Service Charge Statements" : "My Service Charge Statement"}
        </h1>
        <p className="text-sm text-neutral-500">
          {isStaff
            ? "All issued service-charge invoices you have access to."
            : "Charges apportioned to your unit."}
        </p>
      </div>

      {charges.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No service-charge invoices yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-xs text-neutral-400">
                <th className="px-4 py-2 font-medium">Property / Unit</th>
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 text-right font-medium">Share</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id} className="border-b border-neutral-50 last:border-0">
                  <td className="px-4 py-2 text-neutral-700">
                    {c.property_or_unit ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-neutral-600">
                    {c.billing_period ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                    {c.apportionment_pct != null
                      ? `${Number(c.apportionment_pct).toFixed(2)}%`
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium capitalize text-amber-700 ring-1 ring-amber-200">
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-neutral-800">
                    {formatNaira(c.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-200 font-semibold">
                <td className="px-4 py-2 text-neutral-700" colSpan={4}>
                  Total
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-neutral-800">
                  {formatNaira(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
