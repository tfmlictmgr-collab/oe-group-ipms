import { redirect } from "next/navigation";
import {
  Briefcase, Clock, CheckCircle2, Star, Banknote, HardHat,
} from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/currency";
import {
  WEIGHT_LABELS, SCORE_WEIGHTS, averageComposite, scoreBand,
} from "@/lib/vendor-score";
import { PageHeader } from "@/components/patterns/page-header";
import { StatCard } from "@/components/patterns/stat-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

// A vendor's own view: the pipeline, the scorecard, and where the money is.
//
// B7 gives a vendor three cells — assigned jobs, own scorecard + pay status,
// own job cards — and until now they had no page to see any of them on. The RLS
// was already right (0006 for tickets, and the vendor clauses on
// `vendor_evaluations` and `payments`); what was missing was somewhere to look.
//
// ⚠️ Nothing here filters by vendor id. Every query is the plain table, and the
// policies narrow it to `vendors.user_id = auth.uid()`. Restating the filter in
// the query would make this page look safe while hiding whether it actually is —
// if a policy were ever loosened, this page must widen with it, visibly, rather
// than silently masking the fault.

export const dynamic = "force-dynamic";

const OPEN_STATES = ["open", "assigned", "acknowledged", "in_progress"];

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
      })
    : "—";

function bandVariant(score: number) {
  if (score >= 85) return "success" as const;
  if (score >= 70) return "info" as const;
  if (score >= 55) return "warning" as const;
  return "destructive" as const;
}

export default async function MyWorkPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // The vendor record this account IS. `vendors_select` admits a vendor to their
  // own row only, so a single row means "me" — no id is passed in.
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, name, service_category, status, approval_status")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (!vendor) {
    return (
      <div className="space-y-6">
        <PageHeader title="My Work" />
        <EmptyState
          icon={<HardHat />}
          title="No contractor record is linked to this account"
          description="Your account is marked as a contractor, but it is not yet attached to a contractor record. Ask your account manager to link it — jobs, scores and payment status will appear here once they do."
        />
      </div>
    );
  }

  const [jobsRes, openRes, doneRes, evalsRes, paymentsRes] = await Promise.all([
    // ⚠️ Audit 0804 C1. The counts used to be derived from THIS bounded list, so
    // a contractor with more than 100 assigned jobs was shown an "Open jobs"
    // figure that silently stopped counting — while the card beside it was
    // honestly labelled "of the last 100 assigned". A tile that undercounts
    // without saying so is worse than one that admits its bound.
    //
    // The list stays bounded (nobody reads 400 rows); the COUNTS are asked of
    // the database, which counts all of them. Still RLS-scoped — `head: true`
    // runs the same policy, it just returns no rows.
    supabase
      .from("tickets")
      .select("id, summary, message_text, category, urgency, status, created_at, resolved_at, property_or_unit")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .in("status", OPEN_STATES),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .not("status", "in", `(${OPEN_STATES.join(",")})`),
    supabase
      .from("vendor_evaluations")
      .select("id, period, quality_score, response_score, completion_score, satisfaction_score, compliance_score, composite_score, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("payments")
      .select("id, invoice_reference, amount, status, created_at, approved_at, remittance_reference")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  type Job = {
    id: string; summary: string | null; message_text: string | null;
    category: string | null; urgency: string | null; status: string;
    created_at: string; resolved_at: string | null; property_or_unit: string | null;
  };
  const jobs = (jobsRes.data ?? []) as Job[];
  const open = jobs.filter((j) => OPEN_STATES.includes(j.status));
  const inProgress = jobs.filter((j) => j.status === "in_progress").length;

  // Counted in the database, so the tiles are true past the list's bound. If the
  // count query fails, fall back to what the list can see rather than showing a
  // zero that reads as "no work".
  const openCount = openRes.count ?? open.length;
  const doneCount = doneRes.count ?? jobs.filter((j) => !OPEN_STATES.includes(j.status)).length;
  const listTruncated = jobs.length >= 100;

  type Evaluation = {
    id: string; period: string | null; composite_score: number | string | null;
    created_at: string;
    quality_score: number | string | null; response_score: number | string | null;
    completion_score: number | string | null; satisfaction_score: number | string | null;
    compliance_score: number | string | null;
  };
  const evaluations = (evalsRes.data ?? []) as Evaluation[];
  const average = averageComposite(evaluations);
  const latest = evaluations[0] ?? null;

  type Payment = {
    id: string; invoice_reference: string | null; amount: number | string;
    status: string; created_at: string; approved_at: string | null;
    remittance_reference: string | null;
  };
  const payments = (paymentsRes.data ?? []) as Payment[];
  const awaiting = payments
    .filter((p) => p.status !== "remitted" && p.status !== "rejected")
    .reduce((a, p) => a + Number(p.amount), 0);

  const SCORE_COLUMN = {
    quality: "quality_score", response: "response_score",
    completion: "completion_score", satisfaction: "satisfaction_score",
    compliance: "compliance_score",
  } as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title={vendor.name}
        description={[vendor.service_category, "Your jobs, score and payment status"]
          .filter(Boolean)
          .join(" · ")}
        actions={<StatusBadge status={vendor.status} />}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open jobs" value={openCount} icon={<Briefcase />}
                  hint={`${inProgress}${listTruncated ? "+" : ""} in progress`} />
        <StatCard label="Completed" value={doneCount} icon={<CheckCircle2 />}
                  hint="all time" />
        <StatCard
          label="Performance score"
          value={average === null ? "—" : average.toFixed(1)}
          icon={<Star />}
          hint={average === null
            ? "no evaluation recorded yet"
            : `${scoreBand(average).label} · ${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"}`}
        />
        <StatCard label="Awaiting payment" value={formatNaira(awaiting)} icon={<Banknote />}
                  hint="submitted, not yet remitted" />
      </div>

      {/* ── Pipeline ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Current jobs</CardTitle>
          <CardDescription>
            Work assigned to you and not yet completed, newest first.
            {listTruncated && (
              <> Showing the 100 most recent of your {(openCount + doneCount).toLocaleString()} jobs.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {open.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing outstanding. New jobs appear here as soon as they are dispatched to you.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>Urgency</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Raised</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {open.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="max-w-[22rem]">
                        <span className="font-medium">
                          {j.summary ?? (j.message_text ?? "").slice(0, 80) ?? "Job"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {j.id.slice(0, 8).toUpperCase()} · {j.category ?? "unclassified"}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {j.property_or_unit ?? "—"}
                      </TableCell>
                      <TableCell><StatusBadge status={j.urgency} /></TableCell>
                      <TableCell><StatusBadge status={j.status} /></TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtDate(j.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Scorecard ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your scorecard</CardTitle>
          <CardDescription>
            Scored against the AURA weighting: quality 30%, response 20%, completion 20%,
            satisfaction 20%, compliance 10%.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {!latest ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No evaluation has been recorded yet. Your score appears here once your first
              period is assessed.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-3xl font-semibold tabular-nums">
                  {Number(latest.composite_score ?? 0).toFixed(1)}
                </span>
                <Badge variant={bandVariant(Number(latest.composite_score ?? 0))}>
                  {scoreBand(Number(latest.composite_score ?? 0)).label}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  most recent{latest.period ? ` · ${latest.period}` : ""}
                </span>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Criterion</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead className="text-right">Contribution</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {WEIGHT_LABELS.map(({ key, label }) => {
                      const raw = latest[SCORE_COLUMN[key]];
                      const score = raw == null ? null : Number(raw);
                      return (
                        <TableRow key={key}>
                          <TableCell className="font-medium">{label}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {(SCORE_WEIGHTS[key] * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {score === null ? "—" : score.toFixed(0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {score === null ? "—" : (score * SCORE_WEIGHTS[key]).toFixed(1)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {evaluations.length > 1 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3.5" />
                  Averaged across {evaluations.length} evaluations: {average?.toFixed(1)}.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Money ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payment status</CardTitle>
          <CardDescription>
            Where each of your invoices has reached. Payment is released only after the work
            is verified and your performance is validated.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {payments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No invoices submitted yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Submitted</TableHead>
                    <TableHead className="text-right">Remittance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.invoice_reference ?? p.id.slice(0, 8).toUpperCase()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNaira(Number(p.amount))}
                      </TableCell>
                      <TableCell><StatusBadge status={p.status} /></TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtDate(p.created_at)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {p.remittance_reference ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
