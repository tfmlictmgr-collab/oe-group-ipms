import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import AdminOnly from "../AdminOnly";
import RubricEditor, { type Criterion } from "./RubricEditor";

export default async function EvaluationRubricPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="the evaluation rubric" />;

  const supabase = await createClient();
  const { data: criteria } = await supabase
    .from("evaluation_criteria")
    .select("id, dimension, label, measure, response_type, sla_target_hours, max_points, sort_order")
    .eq("active", true)
    .order("dimension")
    .order("sort_order");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vendor evaluation rubric</CardTitle>
        <CardDescription>
          What &ldquo;good&rdquo; means for a completed job, stated as points rather
          than left to a free-typed number. Quality and Compliance are answered by
          your team; Satisfaction is answered by the tenant who raised the request;
          Response and Completion are measured automatically from the job&apos;s own
          timestamps against the target you set here — no one scores those two.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RubricEditor criteria={(criteria as Criterion[]) ?? []} />
      </CardContent>
    </Card>
  );
}
