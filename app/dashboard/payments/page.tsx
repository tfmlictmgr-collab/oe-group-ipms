import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/currency";
import { PAYMENT_STATUS_STYLES, statusLabel } from "@/lib/payment";

type Row = {
  id: string;
  invoice_reference: string | null;
  amount: number | string;
  status: string;
  created_at: string;
  vendors: { name: string } | null;
};

export default async function PaymentsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("payments")
    .select("id, invoice_reference, amount, status, created_at, vendors(name)")
    .order("created_at", { ascending: false });

  const payments = (data as unknown as Row[]) ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-neutral-800">
            Vendor Payments
          </h1>
          <p className="text-sm text-neutral-500">
            Gated remittance: verify → performance → approve → remit.
          </p>
        </div>
        <Link
          href="/dashboard/payments/new"
          className="self-start whitespace-nowrap rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 sm:self-auto"
        >
          + Submit Invoice
        </Link>
      </div>

      {payments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No payment requests yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {payments.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/payments/${p.id}`}
                className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-neutral-800">
                    {p.vendors?.name ?? "—"}
                  </p>
                  <p className="truncate text-xs text-neutral-500">
                    {p.invoice_reference ?? "no ref"}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  <span
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                      PAYMENT_STATUS_STYLES[p.status] ??
                      "bg-neutral-100 text-neutral-600 ring-neutral-200"
                    }`}
                  >
                    {statusLabel(p.status)}
                  </span>
                  <span className="text-right font-semibold tabular-nums text-neutral-800">
                    {formatNaira(p.amount)}
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
