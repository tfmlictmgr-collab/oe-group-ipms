import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { averageComposite, scoreBand } from "@/lib/vendor-score";
import {
  GATE_STAGES,
  PAYMENT_STATUS_STYLES,
  statusLabel,
  type PaymentRow,
} from "@/lib/payment";
import PaymentActions from "./PaymentActions";

// Which gate stages are complete, given the payment's state.
function stageState(payment: PaymentRow) {
  const verification = !!payment.service_verified_at;
  const performance =
    payment.status === "rejected"
      ? "failed"
      : payment.performance_validated
        ? "done"
        : "pending";
  const approval = !!payment.approved_at;
  const remittance = payment.status === "remitted";
  return { verification, performance, approval, remittance };
}

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: payment } = await supabase
    .from("payments")
    .select(
      "id, vendor_id, invoice_reference, amount, status, service_verified_at, performance_validated, approved_at, remittance_reference, created_at, vendors(name)"
    )
    .eq("id", id)
    .single();
  if (!payment) notFound();

  const vendor = payment.vendors as unknown as { name: string } | null;
  const p = payment as unknown as PaymentRow;

  const { data: settings } = await supabase
    .from("payment_settings")
    .select("min_performance_score, approval_threshold_amount")
    .eq("org_id", session.profile!.org_id)
    .single();
  const threshold = Number(settings?.min_performance_score ?? 70);

  const { data: evals } = await supabase
    .from("vendor_evaluations")
    .select("composite_score")
    .eq("vendor_id", p.vendor_id);
  const avg = averageComposite(evals ?? []);
  const band = avg != null ? scoreBand(avg) : null;

  const stages = stageState(p);
  const canAct =
    session.profile?.role === "admin" ||
    session.profile?.role === "facility_manager" ||
    session.profile?.role === "finance_approver";

  const stageBadge = (state: boolean | string) => {
    if (state === "failed")
      return "bg-red-100 text-red-700 ring-red-200";
    if (state === true || state === "done")
      return "bg-emerald-100 text-emerald-700 ring-emerald-200";
    return "bg-neutral-100 text-neutral-400 ring-neutral-200";
  };
  const stateValues = [
    stages.verification,
    stages.performance,
    stages.approval,
    stages.remittance,
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/dashboard/payments"
        className="mb-4 inline-block text-sm text-neutral-500 hover:text-neutral-800"
      >
        ← Back to payments
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-neutral-800">
              {vendor?.name}
            </h1>
            <p className="text-sm text-neutral-500">
              {p.invoice_reference ?? "no reference"}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums text-neutral-800">
              {formatNaira(p.amount)}
            </div>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ${
                PAYMENT_STATUS_STYLES[p.status] ??
                "bg-neutral-100 text-neutral-600 ring-neutral-200"
              }`}
            >
              {statusLabel(p.status)}
            </span>
          </div>
        </div>

        {/* Performance context */}
        <div className="mt-5 flex items-center justify-between rounded-lg bg-neutral-50 px-4 py-3 text-sm">
          <span className="text-neutral-500">
            Vendor composite score vs. threshold ({threshold})
          </span>
          <span className="flex items-center gap-2">
            {band && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${band.style}`}
              >
                {band.label}
              </span>
            )}
            <span
              className={`font-semibold tabular-nums ${
                avg != null && avg >= threshold
                  ? "text-emerald-700"
                  : "text-red-600"
              }`}
            >
              {avg != null ? avg.toFixed(1) : "—"}
            </span>
          </span>
        </div>
      </div>

      {/* Gate stepper */}
      <div className="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-4 text-sm font-semibold text-neutral-700">
          B4 payment gate
        </h2>
        <ol className="space-y-3">
          {GATE_STAGES.map((stage, i) => {
            const state = stateValues[i];
            const done = state === true || state === "done";
            const failed = state === "failed";
            return (
              <li key={stage.key} className="flex items-center gap-3">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ring-1 ${stageBadge(state)}`}
                >
                  {failed ? "×" : done ? "✓" : i + 1}
                </span>
                <span
                  className={`text-sm ${
                    done
                      ? "font-medium text-neutral-800"
                      : failed
                        ? "font-medium text-red-600"
                        : "text-neutral-400"
                  }`}
                >
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>

        {canAct && (
          <div className="mt-5 border-t border-neutral-100 pt-4">
            <PaymentActions paymentId={p.id} status={p.status} />
          </div>
        )}

        {p.remittance_reference && (
          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm">
            <div className="font-semibold text-amber-800">
              SIMULATED — POC ONLY
            </div>
            <div className="text-amber-700">
              Remittance reference: {p.remittance_reference}. No live gateway
              (Paystack/Flutterwave) is integrated.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
