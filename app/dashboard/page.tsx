import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { type Ticket } from "@/lib/ticket-format";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import TicketList from "./TicketList";

export default async function DashboardPage() {
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
