import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { type Ticket } from "@/lib/ticket-format";
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
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-neutral-800">
            Service Requests
          </h1>
          <p className="text-sm text-neutral-500">
            Requests you have access to, updating in real time.
          </p>
        </div>
        <Link
          href="/dashboard/new"
          className="self-start whitespace-nowrap rounded-lg btn-brand px-4 py-2 text-sm font-medium text-white sm:self-auto"
        >
          + New Request
        </Link>
      </div>

      <TicketList initialTickets={(tickets as Ticket[]) ?? []} />
    </div>
  );
}
