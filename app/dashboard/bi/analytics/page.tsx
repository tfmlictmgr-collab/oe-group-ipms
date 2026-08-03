import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { biScope } from "../scope";
import { loadAnalytics, type Filters } from "./actions";
import AnalyticsConsole, { type Option } from "./AnalyticsConsole";

// Day 10 — the filterable analytics console.
//
// The executive dashboard answers "how are we doing"; this answers "how are we
// doing on THIS, over THAT period, compared with THEM". Same data, same RLS —
// the difference is that every dimension is a parameter rather than a fixed view.
//
// The `requests` capability gates it (B7): a finance approver's BI is the money
// columns, and a console of ticket turnaround is not theirs. Everyone who does
// reach it sees only their own scope, because `bi_ticket_metrics` is plain SQL
// over an RLS-protected table.

// Filters are read at request time and the figures are live.
export const dynamic = "force-dynamic";

const CATEGORIES = ["maintenance", "billing", "vendor", "complaint", "general"];

export default async function AnalyticsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const role = session.profile?.role;
  const scope = biScope(role);

  if (!scope.requests) {
    return (
      <div className="space-y-6">
        <PageHeader title="Analytics Console" />
        <EmptyState
          icon={<BarChart3 />}
          title="Not available for your role"
          description="Request analytics are available to operational and executive roles. The financial dashboard is on the Analytics page."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/bi"><ArrowLeft /> Back to the dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const supabase = await createClient();

  // Monthly, unfiltered, all of time — the board's chosen default (1 Aug 2026).
  const initialFilters: Filters = { bucket: "month" };

  // The pickers are populated from what the CALLER can see, so an FM/PM is not
  // offered a property they would then get an empty chart for. Same reason the
  // hierarchy picker lists only reachable nodes.
  const [initialRes, vendorsRes, propertiesRes] = await Promise.all([
    loadAnalytics(initialFilters),
    // `vendors` is retired by `status`, not a soft-delete column — filtering on a
    // `deleted_at` it does not have returns an ERROR, and an error here reads as
    // an empty picker, which reads as "this org has no contractors". It does not
    // look like a bug, which is what makes it one.
    scope.vendorPerf
      ? supabase.from("vendors").select("id, name").order("name")
      : Promise.resolve({ data: [], error: null }),
    supabase.from("properties").select("id, name").is("deleted_at", null).order("name"),
  ]);

  // A picker that silently empties itself is worse than one that says why.
  if (vendorsRes.error) console.error("[analytics] vendor picker:", vendorsRes.error.message);
  if (propertiesRes.error) console.error("[analytics] property picker:", propertiesRes.error.message);

  // A genuine fault, not a permission boundary — RLS returns rows, not errors.
  if (!initialRes.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="Analytics Console" />
        <EmptyState
          icon={<BarChart3 />}
          title="Could not load the figures"
          description={initialRes.message}
        />
      </div>
    );
  }

  const vendors = ((vendorsRes.data ?? []) as Option[]).filter((v) => v.name);
  const properties = ((propertiesRes.data ?? []) as Option[]).filter((p) => p.name);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics Console"
        description="Request volume, completion and turnaround — filtered by period, property, vendor, category and status."
        actions={
          <Button asChild variant="ghost">
            <Link href="/dashboard/bi"><ArrowLeft /> Dashboard</Link>
          </Button>
        }
      />
      <AnalyticsConsole
        initial={initialRes.data}
        initialFilters={initialFilters}
        vendors={vendors}
        properties={properties}
        categories={CATEGORIES}
        showVendors={scope.vendorPerf}
      />
    </div>
  );
}
