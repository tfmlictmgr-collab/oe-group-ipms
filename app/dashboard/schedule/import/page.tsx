import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { capabilityRefusal } from "@/lib/capability-refusal";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

/**
 * Bulk import for the tenancy schedule (0265).
 *
 * The schedule is the MANAGEMENT PORTFOLIO workbook rendered live, and this is
 * how a portfolio that is already let gets into it. Entering thirteen sheets of
 * tenancies one form at a time is not a migration path.
 *
 * Gated on `leases.write` — the same capability the single-tenancy form needs,
 * because this is that act at scale and not a different one. The database
 * refuses it regardless: `import_tenancies` runs as the caller, so every
 * inserted row meets `leases_write` exactly as a hand-entered one does.
 */
export default async function ImportSchedulePage() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  const profile = session.profile;

  const supabase = await createClient();
  const [{ data: canWrite }, { data: hasLettings }] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
  ]);

  if (!hasLettings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Import tenancies" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Lettings is not enabled here"
          description="Tenancies, rent and landlord schedules belong to the property side of the group."
        />
      </div>
    );
  }

  if (!canWrite) {
    // Role or org — the matrix decides which is true, and telling somebody
    // "your organisation" is false the moment their colleagues already hold it.
    const refusal = await capabilityRefusal(supabase, "leases.write", "Importing tenancies");
    return (
      <div className="space-y-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/schedule"><ArrowLeft className="size-4" /> Tenancy schedule</Link>
        </Button>
        <PageHeader title="Import tenancies" />
        <EmptyState
          icon={<ShieldAlert />}
          title={refusal.message}
          description={`${refusal.hint} Importing a rent roll sets what real people are billed, so it needs the same permission as recording one tenancy.`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/schedule"><ArrowLeft className="size-4" /> Tenancy schedule</Link>
      </Button>

      <PageHeader
        title="Import tenancies"
        description="Bring an existing rent roll in from a spreadsheet. Every row is checked against your own properties and units before anything is recorded."
      />

      <ImportClient />
    </div>
  );
}
