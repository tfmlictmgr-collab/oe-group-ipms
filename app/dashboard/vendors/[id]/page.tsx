import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
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
                description="Scores appear here once a facility manager submits an evaluation."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
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
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">{e.period ?? "—"}</TableCell>
                    {WEIGHT_LABELS.map((w) => (
                      <TableCell
                        key={w.key}
                        className="text-right tabular-nums text-muted-foreground"
                      >
                        {String(e[SCORE_COLUMN[w.key]] ?? "—")}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-semibold tabular-nums">
                      {e.composite_score != null
                        ? Number(e.composite_score).toFixed(1)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canEvaluate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Submit new evaluation</CardTitle>
          </CardHeader>
          <CardContent>
            <EvaluationForm vendorId={vendor.id} orgId={session.profile!.org_id} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
