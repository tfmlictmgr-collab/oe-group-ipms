import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Check, X, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { averageComposite, scoreBand } from "@/lib/vendor-score";
import { cn } from "@/lib/utils";
import { GATE_STAGES, statusLabel, type PaymentRow } from "@/lib/payment";
import { PageHeader } from "@/components/patterns/page-header";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import PaymentActions from "./PaymentActions";

// Gate progress is derived from `status` alone — it is the authoritative state
// machine. Deriving from the individual timestamp columns instead lets the
// stepper drift out of sync with status if those columns are ever written
// independently.
const STATUS_RANK: Record<string, number> = {
  pending_verification: 0,
  pending_evaluation: 1,
  verified: 1,
  recommended: 2,
  pending_approval: 2,
  approved: 3,
  remitted: 4,
};

function stageState(payment: PaymentRow) {
  const rejected = payment.status === "rejected";
  const rank = STATUS_RANK[payment.status] ?? 0;
  return {
    verification: rejected ? true : rank >= 1,
    performance: rejected ? "failed" : rank >= 2 ? "done" : "pending",
    approval: rank >= 3,
    remittance: rank >= 4,
  };
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
      "id, vendor_id, invoice_reference, amount, status, service_verified_at, performance_validated, approved_at, remittance_reference, created_at, rejected_reason, rejected_at, vendors(name)"
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
  const passesGate = avg != null && avg >= threshold;

  const stages = stageState(p);
  const canAct =
    session.profile?.role === "admin" ||
    session.profile?.role === "facility_manager" ||
    session.profile?.role === "finance_approver";

  const stateValues = [
    stages.verification,
    stages.performance,
    stages.approval,
    stages.remittance,
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={vendor?.name ?? "Payment"}
        description={p.invoice_reference ?? "no reference"}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/payments">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-5 pt-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invoice amount
              </p>
              <p className="text-3xl font-semibold tabular-nums">
                {formatNaira(p.amount)}
              </p>
            </div>
            <StatusBadge status={p.status} label={statusLabel(p.status)} />
          </div>

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Vendor performance</p>
              <p className="text-xs text-muted-foreground">
                Composite score vs. threshold of {threshold}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {band && avg != null && (
                <Badge variant={passesGate ? "success" : "destructive"}>{band.label}</Badge>
              )}
              <span
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  passesGate ? "text-success" : "text-destructive"
                )}
              >
                {avg != null ? avg.toFixed(1) : "—"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">B4 payment gate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="space-y-0">
            {GATE_STAGES.map((stage, i) => {
              const state = stateValues[i];
              const done = state === true || state === "done";
              const failed = state === "failed";
              const isLast = i === GATE_STAGES.length - 1;
              return (
                <li key={stage.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                        failed
                          ? "bg-destructive text-destructive-foreground"
                          : done
                            ? "bg-success text-success-foreground"
                            : "border border-border bg-muted text-muted-foreground"
                      )}
                    >
                      {failed ? <X className="size-3.5" /> : done ? <Check className="size-3.5" /> : i + 1}
                    </span>
                    {!isLast && (
                      <span
                        className={cn(
                          "my-1 w-px flex-1",
                          done ? "bg-success/40" : "bg-border"
                        )}
                      />
                    )}
                  </div>
                  <span
                    className={cn(
                      "pb-5 pt-1 text-sm",
                      done
                        ? "font-medium"
                        : failed
                          ? "font-medium text-destructive"
                          : "text-muted-foreground"
                    )}
                  >
                    {stage.label}
                  </span>
                </li>
              );
            })}
          </ol>

          {canAct && (
            <>
              <Separator />
              <PaymentActions
                paymentId={p.id}
                status={p.status}
                amount={Number(p.amount)}
                vendorName={vendor?.name ?? "this vendor"}
                rejectedReason={p.rejected_reason ?? null}
                // Reopening corrects someone else's refusal, so it sits with
                // the people who answer for the money. The trigger enforces
                // this regardless of what the page renders.
                canReopen={["admin", "finance_approver"].includes(session.profile?.role ?? "")}
              />
            </>
          )}

          {p.status === "remitted" && p.remittance_reference && (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
              <div>
                <p className="font-semibold">SIMULATED — POC ONLY</p>
                <p className="text-muted-foreground">
                  Remittance reference: {p.remittance_reference}. No live gateway
                  (Paystack/Flutterwave) is integrated.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
