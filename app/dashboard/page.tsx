import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { type Ticket } from "@/lib/ticket-format";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import TicketList from "./TicketList";

export default async function DashboardPage() {
  // A viewer has no policy on tickets, so this page would render an empty list
  // that reads as a broken build rather than a withheld one. Send them to the
  // page that is actually theirs.
  const session = await getSessionProfile();
  if (session?.profile?.role === "viewer") redirect("/dashboard/overview");

  const supabase = await createClient();
  const { data: tickets } = await supabase
    .from("tickets")
    .select(
      "id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at"
    )
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service Requests"
        description="Requests you have access to, updating in real time."
        actions={
          <Button asChild variant="brand">
            <Link href="/dashboard/new">
              <Plus /> New Request
            </Link>
          </Button>
        }
      />
      <TicketList initialTickets={(tickets as Ticket[]) ?? []} />
    </div>
  );
}
