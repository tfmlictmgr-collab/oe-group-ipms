import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import RequisitionForm from "../RequisitionForm";

// Raising an FM/PM ops requisition — reachable from the shared Requests
// screen, My Jobs, and (with a ticket already chosen) from that job's own
// page. Same eligibility raise_ops_requisition itself enforces server-side
// (0170): operational staff and the people above them.
const ELIGIBLE = ["fm_ops_staff", "facility_manager", "regional_manager", "admin"];

export default async function NewRequisitionPage({
  searchParams,
}: {
  searchParams: Promise<{ ticket?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  if (!ELIGIBLE.includes(session.profile.role)) redirect("/dashboard");

  const { ticket: ticketId } = await searchParams;

  const supabase = await createClient();
  const [{ data: vendors }, ticketRes] = await Promise.all([
    supabase.from("vendors").select("id, name").order("name"),
    ticketId
      ? supabase.from("tickets").select("id, summary, message_text").eq("id", ticketId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const ticket = ticketRes.data as { id: string; summary: string | null; message_text: string } | null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Raise a requisition"
        description="Cost lines for a job — materials, a casual hire, anything spent that needs to be paid back or paid out."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={ticket ? `/dashboard/tickets/${ticket.id}` : "/dashboard"}>
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-6">
          <RequisitionForm
            vendors={vendors ?? []}
            ticketId={ticket?.id ?? null}
            ticketLabel={ticket ? (ticket.summary ?? ticket.message_text.slice(0, 80)) : null}
            orgId={session.profile.org_id}
          />
        </CardContent>
      </Card>
    </div>
  );
}
