import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { averageComposite, scoreBand } from "@/lib/vendor-score";

type VendorRow = {
  id: string;
  name: string;
  service_category: string | null;
  status: string;
  vendor_evaluations: { composite_score: number | string | null }[];
};

export default async function VendorsPage() {
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
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-800">Vendors</h1>
        <p className="text-sm text-neutral-500">
          Ranked by composite performance score (weighted per AURA).
        </p>
      </div>

      {vendors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white/60 p-10 text-center text-sm text-neutral-500">
          No vendors yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {vendors.map((v, i) => {
            const band = v.avg != null ? scoreBand(v.avg) : null;
            return (
              <li key={v.id}>
                <Link
                  href={`/dashboard/vendors/${v.id}`}
                  className="flex items-center justify-between gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-500">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-medium text-neutral-800">{v.name}</p>
                      <p className="text-xs capitalize text-neutral-500">
                        {v.service_category ?? "—"} · {v.count} evaluation
                        {v.count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {band && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${band.style}`}
                      >
                        {band.label}
                      </span>
                    )}
                    <span className="w-12 text-right text-lg font-semibold tabular-nums text-neutral-800">
                      {v.avg != null ? v.avg.toFixed(1) : "—"}
                    </span>
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
