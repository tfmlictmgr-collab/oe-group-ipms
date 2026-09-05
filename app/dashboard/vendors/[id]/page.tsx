import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Mail, Phone, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import PayoutRecipientForm from "./PayoutRecipientForm";
import {
  WEIGHT_LABELS,
  SCORE_WEIGHTS,
  averageComposite,
  scoreBand,
} from "@/lib/vendor-score";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FM_PM } from "@/lib/roles";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

// A row from either source, normalised to one shape for display:
//   - legacy: a pre-Day-11 free-typed period entry (`vendor_evaluations`,
//     ticket_id is null) — kept exactly as submitted, never rewritten.
//   - job: a ticket-driven, checklist/SLA-derived evaluation
//     (`vendor_evaluation_tickets`) — composite is null while awaiting the
//     other source, never estimated.
type Row = {
  key: string;
  when: string;
  label: string;
  quality_score: number | string | null;
  response_score: number | string | null;
  completion_score: number | string | null;
  satisfaction_score: number | string | null;
  compliance_score: number | string | null;
  composite_score: number | string | null;
  pending: string | null;
};

const SCORE_COLUMN: Record<string, keyof Row> = {
  quality: "quality_score",
  response: "response_score",
  completion: "completion_score",
  satisfaction: "satisfaction_score",
  compliance: "compliance_score",
};

function bandVariant(score: number) {
  if (score >= 85) return "success" as const;
  if (score >= 70) return "info" as const;
  if (score >= 55) return "warning" as const;
  return "destructive" as const;
}

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

  // Where this vendor is paid. Finance and admin only — an FM/PM runs the work,
  // not the bank details.
  const isFinanceOrAdmin = ["admin", "finance_approver"].includes(session.profile?.role ?? "");
  const { data: recipient } = isFinanceOrAdmin
    ? await supabase
        .from("payout_recipients")
        .select("display_name, bank_name, account_number_last4, verified_at")
        .eq("vendor_id", id)
        .eq("active", true)
        .maybeSingle()
    : { data: null };

  const [legacyRes, jobRes] = await Promise.all([
    supabase
      .from("vendor_evaluations")
      .select(
        "id, period, quality_score, response_score, completion_score, satisfaction_score, compliance_score, composite_score, created_at"
      )
      .eq("vendor_id", id)
      .is("ticket_id", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("vendor_evaluation_tickets")
      .select(
        "ticket_id, quality_score, response_score, completion_score, satisfaction_score, compliance_score, composite_score, fm_pm_submitted_at, tenant_submitted_at, awaiting_tenant, awaiting_fm_pm"
      )
      .eq("vendor_id", id)
      .order("fm_pm_submitted_at", { ascending: false, nullsFirst: false }),
  ]);

  const evaluations: Row[] = [
    ...((legacyRes.data ?? []) as {
      id: string; period: string | null; created_at: string;
      quality_score: number | string | null; response_score: number | string | null;
      completion_score: number | string | null; satisfaction_score: number | string | null;
      compliance_score: number | string | null; composite_score: number | string | null;
    }[]).map((e) => ({
      key: e.id,
      when: e.period ?? new Date(e.created_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" }),
      label: "Period entry",
      quality_score: e.quality_score, response_score: e.response_score,
      completion_score: e.completion_score, satisfaction_score: e.satisfaction_score,
      compliance_score: e.compliance_score, composite_score: e.composite_score,
      pending: null,
    })),
    ...((jobRes.data ?? []) as {
      ticket_id: string; quality_score: number | string | null; response_score: number | string | null;
      completion_score: number | string | null; satisfaction_score: number | string | null;
      compliance_score: number | string | null; composite_score: number | string | null;
      fm_pm_submitted_at: string | null; tenant_submitted_at: string | null;
      awaiting_tenant: boolean; awaiting_fm_pm: boolean;
    }[]).map((e) => ({
      key: e.ticket_id,
      when: new Date(e.fm_pm_submitted_at ?? e.tenant_submitted_at ?? "").toLocaleDateString(
        "en-GB", { timeZone: "Africa/Lagos" }
      ),
      label: e.ticket_id.slice(0, 8).toUpperCase(),
      quality_score: e.quality_score, response_score: e.response_score,
      completion_score: e.completion_score, satisfaction_score: e.satisfaction_score,
      compliance_score: e.compliance_score, composite_score: e.composite_score,
      pending: e.awaiting_tenant ? "Awaiting tenant" : e.awaiting_fm_pm ? "Awaiting FM/PM" : null,
    })),
  ];

  const avg = averageComposite(evaluations);
  const band = avg != null ? scoreBand(avg) : null;

  const canEvaluate =
    session.profile?.role === "admin" ||
    (FM_PM as readonly string[]).includes(session.profile?.role ?? "");

  // Completed jobs for this vendor with no fm_pm evaluation yet — the
  // free-typed "submit a new evaluation" form is gone; a checklist can only be
  // answered against a REAL completed job, so this points straight at it
  // instead of asking for a period nobody's evaluation was ever really "for".
  const { data: pendingTickets } = canEvaluate
    ? await supabase
        .from("tickets")
        .select("id, summary, message_text, resolved_at")
        .eq("assigned_vendor_id", id)
        .in("status", ["resolved", "closed"])
        .order("resolved_at", { ascending: false })
        .limit(20)
    : { data: null };

  // A ticket can already appear in the view because the TENANT submitted
  // first — that is not the same as "our team already evaluated it".
  const fmAlreadySubmitted = new Set(
    (jobRes.data ?? []).filter((r) => r.fm_pm_submitted_at != null).map((r) => r.ticket_id)
  );
  const awaitingFmEvaluation = (pendingTickets ?? []).filter((t) => !fmAlreadySubmitted.has(t.id));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={vendor.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {vendor.service_category ?? "—"}
            </Badge>
            <Badge variant={vendor.status === "active" ? "success" : "muted"} className="capitalize">
              {vendor.status}
            </Badge>
          </span>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/vendors">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5 text-sm">
              {vendor.contact_email && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="size-4" /> {vendor.contact_email}
                </p>
              )}
              {vendor.contact_phone && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="size-4" /> {vendor.contact_phone}
                </p>
              )}
            </div>
            <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
              <div className="text-4xl font-semibold tabular-nums">
                {avg != null ? avg.toFixed(1) : "—"}
              </div>
              <div className="flex flex-col items-start gap-1 sm:items-end">
                {band && avg != null && <Badge variant={bandVariant(avg)}>{band.label}</Badge>}
                <p className="text-xs text-muted-foreground">avg composite</p>
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-5">
            {WEIGHT_LABELS.map((w) => (
              <div key={w.key} className="space-y-0.5">
                <div className="text-xs font-medium">{w.label}</div>
                <div className="text-xs text-muted-foreground">
                  {Math.round(SCORE_WEIGHTS[w.key] * 100)}% weight
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evaluation history</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {evaluations.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState
                title="No evaluations yet"
                description="A vendor is scored automatically as jobs complete — Response and Completion from the job's own timestamps, Quality and Compliance from your team's checklist, Satisfaction from the tenant's review."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  {WEIGHT_LABELS.map((w) => (
                    <TableHead key={w.key} className="text-right">
                      {w.label.split(" ")[0]}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Composite</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evaluations.map((e) => (
                  <TableRow key={e.key}>
                    <TableCell className="font-medium">
                      {e.label}
                      <span className="block text-xs font-normal text-muted-foreground">{e.when}</span>
                    </TableCell>
                    {WEIGHT_LABELS.map((w) => (
                      <TableCell
                        key={w.key}
                        className="text-right tabular-nums text-muted-foreground"
                      >
                        {e[SCORE_COLUMN[w.key]] != null ? Number(e[SCORE_COLUMN[w.key]]).toFixed(0) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-semibold tabular-nums">
                      {e.composite_score != null ? (
                        Number(e.composite_score).toFixed(1)
                      ) : e.pending ? (
                        <span className="flex items-center justify-end gap-1 text-xs font-normal text-muted-foreground">
                          <Clock className="size-3" /> {e.pending}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isFinanceOrAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payout details</CardTitle>
            <CardDescription>
              A vendor cannot be remitted until a bank account has been verified
              against their name.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PayoutRecipientForm
              vendorId={vendor.id}
              vendorName={vendor.name}
              existing={recipient ?? null}
              canEdit={session.profile?.role === "admin"}
            />
          </CardContent>
        </Card>
      )}

      {canEvaluate && awaitingFmEvaluation.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jobs awaiting your evaluation</CardTitle>
            <CardDescription>
              Response and completion time are already measured automatically —
              open a job to answer the quality and compliance checklist.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {awaitingFmEvaluation.map((t) => (
              <Link
                key={t.id}
                href={`/dashboard/tickets/${t.id}`}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2.5 text-sm hover:bg-accent"
              >
                <span className="min-w-0 truncate">{t.summary ?? t.message_text}</span>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {t.resolved_at
                    ? new Date(t.resolved_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" })
                    : ""}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
