import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { sectionsFor, type Section } from "@/lib/application-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import ReviewPanel from "./ReviewPanel";
import AttachmentList from "./AttachmentList";

const STATUS_LABEL: Record<string, string> = {
  submitted: "New",
  under_review: "Under review",
  info_requested: "Awaiting applicant",
  approved: "Approved",
  rejected: "Rejected",
};

export default async function ApplicationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();

  const [appRes, recommendRes, approveRes] = await Promise.all([
    // `application_overview` never selects `sensitive` — the only thing this
    // page can show is what the view already withholds nothing else from.
    supabase.from("application_overview").select("*").eq("id", id).maybeSingle(),
    supabase.rpc("has_permission", { p_capability: "applications.recommend" }),
    supabase.rpc("has_permission", { p_capability: "applications.approve" }),
  ]);

  const application = appRes.data;
  if (!application) notFound();

  const [attachRes, decisionsRes, requirementsRes, unitsRes] = await Promise.all([
    supabase
      .from("application_attachments")
      .select("id, kind, storage_path, file_name, uploaded_at")
      .eq("application_id", id)
      .order("uploaded_at"),
    supabase
      .from("application_decisions")
      .select("kind, decided_by, reason, created_at, users:decided_by(full_name)")
      .eq("application_id", id)
      .order("created_at"),
    supabase
      .from("application_document_requirements")
      .select("kind, label, required")
      .eq("org_id", profile.org_id)
      .eq("type", application.type)
      .order("sort_order"),
    application.property_id
      ? supabase
          .from("units")
          .select("id, label")
          .eq("property_id", application.property_id)
          .is("occupant_user_id", null)
          .is("deleted_at", null)
          .order("label")
      : Promise.resolve({ data: [] as { id: string; label: string }[] }),
  ]);

  const sections: Section[] = sectionsFor(application.type);
  const form = (application.form ?? {}) as Record<string, unknown>;
  const attachments = attachRes.data ?? [];
  const requirements = requirementsRes.data ?? [];
  const attachedKinds = new Set(attachments.map((a) => a.kind));
  const missing = requirements.filter((r) => r.required && !attachedKinds.has(r.kind));

  const canRecommend = Boolean(recommendRes.data);
  const canApprove = Boolean(approveRes.data);
  const isRecommender = application.recommended_by === profile.id;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="text-base">{application.applicant_name}</CardTitle>
            <CardDescription>
              {application.type === "corporate" ? "Business" : "Individual"} application
              {" · "}submitted{" "}
              {application.submitted_at
                ? new Date(application.submitted_at).toLocaleDateString("en-NG", {
                    day: "numeric", month: "short", year: "numeric",
                  })
                : "—"}
            </CardDescription>
          </div>
          <Badge variant={application.status === "approved" ? "success" : application.status === "rejected" ? "destructive" : "outline"}>
            {STATUS_LABEL[application.status] ?? application.status}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Email</p>
            <p>{application.applicant_email}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Phone</p>
            <p>{application.applicant_phone || "—"}</p>
          </div>
          {application.status === "under_review" && (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">Progress</p>
              <p>
                {application.approvals_count} of {application.approvals_needed} approval
                {application.approvals_needed === 1 ? "" : "s"}
                {application.recommendation && ` · recommended ${application.recommendation}`}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Documents</CardTitle>
          <CardDescription>
            {missing.length > 0
              ? `Still to upload: ${missing.map((m) => m.label).join(", ")}.`
              : "Everything required has been uploaded."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttachmentList attachments={attachments} requirements={requirements} />
        </CardContent>
      </Card>

      {sections.map((section) => {
        const visible = section.fields.filter((f) => !f.sensitive && form[f.key] !== undefined && form[f.key] !== "");
        if (visible.length === 0) return null;
        return (
          <Card key={section.key}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{section.title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
              {visible.map((f) => (
                <div key={f.key} className={f.half ? undefined : "sm:col-span-2"}>
                  <p className="text-xs text-muted-foreground">{f.label}</p>
                  <p className="whitespace-pre-wrap">
                    {f.type === "checkbox" ? (form[f.key] ? "Yes" : "No") : String(form[f.key])}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      {decisionsRes.data && decisionsRes.data.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Review history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {decisionsRes.data.map((d, i) => (
              <div key={i} className="text-sm">
                <p className="font-medium">
                  {decisionLabel(d.kind)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {(d.users as unknown as { full_name: string } | null)?.full_name ?? "—"}
                    {" · "}
                    {new Date(d.created_at).toLocaleDateString("en-NG", { day: "numeric", month: "short" })}
                  </span>
                </p>
                <p className="mt-0.5 text-muted-foreground">{d.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <ReviewPanel
        applicationId={application.id}
        status={application.status}
        applicantEmail={application.applicant_email}
        applicantName={application.applicant_name}
        orgId={application.org_id}
        unitId={application.unit_id}
        canRecommend={canRecommend}
        canApprove={canApprove}
        isRecommender={isRecommender}
        documentsComplete={missing.length === 0}
        vacantUnits={unitsRes.data ?? []}
      />
    </div>
  );
}

function decisionLabel(kind: string): string {
  switch (kind) {
    case "recommend_approve": return "Recommended for approval";
    case "recommend_reject": return "Recommended for rejection";
    case "request_info": return "Requested more information";
    case "approve": return "Approved";
    case "reject": return "Rejected";
    default: return kind;
  }
}
