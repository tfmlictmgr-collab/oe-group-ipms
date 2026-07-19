import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import {
  WEIGHT_LABELS,
  SCORE_WEIGHTS,
  averageComposite,
  scoreBand,
} from "@/lib/vendor-score";
import EvaluationForm from "./EvaluationForm";

type Evaluation = {
  id: string;
  period: string | null;
  quality_score: number | string | null;
  response_score: number | string | null;
  completion_score: number | string | null;
  satisfaction_score: number | string | null;
  compliance_score: number | string | null;
  composite_score: number | string | null;
  created_at: string;
};

const SCORE_COLUMN: Record<string, keyof Evaluation> = {
  quality: "quality_score",
  response: "response_score",
  completion: "completion_score",
  satisfaction: "satisfaction_score",
  compliance: "compliance_score",
};

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, name, service_category, contact_email, contact_phone, status")
    .eq("id", id)
    .single();

  if (!vendor) notFound();

  const { data: evalData } = await supabase
    .from("vendor_evaluations")
    .select(
      "id, period, quality_score, response_score, completion_score, satisfaction_score, compliance_score, composite_score, created_at"
    )
    .eq("vendor_id", id)
    .order("period", { ascending: false });

  const evaluations = (evalData as Evaluation[]) ?? [];
  const avg = averageComposite(evaluations);
  const band = avg != null ? scoreBand(avg) : null;

  const canEvaluate =
    session.profile?.role === "admin" ||
    session.profile?.role === "facility_manager";

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/vendors"
        className="mb-4 inline-block text-sm text-neutral-500 hover:text-neutral-800"
      >
        ← Back to vendors
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-neutral-800">
              {vendor.name}
            </h1>
            <p className="text-sm capitalize text-neutral-500">
              {vendor.service_category ?? "—"} · {vendor.status}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              {vendor.contact_email} · {vendor.contact_phone}
            </p>
          </div>
          <div className="flex-shrink-0 sm:text-right">
            <div className="text-3xl font-bold tabular-nums text-neutral-800">
              {avg != null ? avg.toFixed(1) : "—"}
            </div>
            {band && (
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${band.style}`}
              >
                {band.label}
              </span>
            )}
            <p className="mt-1 text-xs text-neutral-400">avg composite</p>
          </div>
        </div>

        {/* Weight legend */}
        <div className="mt-5 grid grid-cols-2 gap-2 border-t border-neutral-100 pt-4 text-xs text-neutral-500 sm:grid-cols-5">
          {WEIGHT_LABELS.map((w) => (
            <div key={w.key}>
              <div className="font-medium text-neutral-700">{w.label}</div>
              <div>{Math.round(SCORE_WEIGHTS[w.key] * 100)}% weight</div>
            </div>
          ))}
        </div>
      </div>

      {/* Evaluation history */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-neutral-700">
          Evaluation history
        </h2>
        {evaluations.length === 0 ? (
          <p className="text-sm text-neutral-500">No evaluations yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-xs text-neutral-400">
                  <th className="px-4 py-2 font-medium">Period</th>
                  {WEIGHT_LABELS.map((w) => (
                    <th key={w.key} className="px-3 py-2 text-right font-medium">
                      {w.label.split(" ")[0]}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right font-medium">Composite</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-neutral-50 last:border-0"
                  >
                    <td className="px-4 py-2 font-medium text-neutral-700">
                      {e.period ?? "—"}
                    </td>
                    {WEIGHT_LABELS.map((w) => (
                      <td
                        key={w.key}
                        className="px-3 py-2 text-right tabular-nums text-neutral-600"
                      >
                        {String(e[SCORE_COLUMN[w.key]] ?? "—")}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-neutral-800">
                      {e.composite_score != null
                        ? Number(e.composite_score).toFixed(1)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Submit evaluation (FM/admin only) */}
      {canEvaluate && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-neutral-700">
            Submit new evaluation
          </h2>
          <EvaluationForm vendorId={vendor.id} orgId={session.profile!.org_id} />
        </div>
      )}
    </div>
  );
}
