import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, Plus, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import LeaseStats from "./LeaseStats";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import RentRollTable, { type RentRollRow } from "./RentRollTable";

// The rent roll: the tenancy schedule a landlord is handed, and the screen a
// property manager works from.
//
// `rent_roll` is security_invoker, so what appears here is already scoped —
// a landlord sees their portfolio, an FM/PM the properties they hold. No
// filtering is repeated in this file, deliberately: a second scoping rule is a
// second thing to get wrong.
export default async function LeasesPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  // A tenant has a rent screen of their own, and this is not it. The nav has
  // never offered this link to them (`seesLettings` is capability-derived), but
  // the nav is a courtesy and never the boundary — and until 0229 a tenant who
  // typed this URL was rendered their own tenancy under a column headed
  // "Landlord net", because `rent_roll` computed the fee split under the
  // reader. The view now declines them, so the honest thing is to send them
  // where their rent actually lives rather than to an empty table.
  if (profile.role === "tenant") redirect("/dashboard/my-rent");

  const supabase = await createClient();
  const [rollRes, moduleRes, canWriteRes] = await Promise.all([
    supabase
      .from("rent_roll")
      .select(
        "lease_id, property_name, unit_label, tenant_user_id, tenant_name, tenant_phone, tenant_email, status, " +
        "start_date, end_date, days_to_expiry, rent_amount, rent_frequency, currency, " +
        "rent_billed, rent_collected, rent_outstanding, landlord_net"
      )
      .order("end_date"),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
  ]);

  if (!moduleRes.data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leases & rent" />
        <EmptyState
          icon={<FileText />}
          title="Lettings is not enabled here"
          description="Tenancies, rent and landlord statements belong to the property side of the group. A facilities organisation has no leases to administer."
        />
      </div>
    );
  }

  // `rent_roll` is a view added in 0091 and is not in the generated types yet,
  // so the client types its rows as errors.
  const rows = (rollRes.data ?? []) as unknown as {
    lease_id: string; property_name: string; unit_label: string;
    tenant_user_id: string | null; tenant_name: string | null; tenant_phone: string | null;
    tenant_email: string | null;
    status: string; start_date: string; end_date: string; days_to_expiry: number;
    rent_amount: number; rent_frequency: string; currency: string;
    rent_billed: number; rent_collected: number; rent_outstanding: number;
    landlord_net: number;
  }[];

  const canWrite = Boolean(canWriteRes.data);

  // 📌 12 Sept 2026: `rent_roll` now coalesces the portal account with the
  // tenant of record itself (0291, matching `tenancy_schedule`'s pattern), so
  // a company let or an imported tenancy is named without a second query here.
  // `of_record` — "no portal account, only a name on file" — is just the
  // absence of `tenant_user_id` on a row that still has a name.
  const tableRows: RentRollRow[] = rows.map((r) => ({
    ...r,
    of_record: !r.tenant_user_id && Boolean(r.tenant_name),
  }));
  const live = rows.filter((r) => r.status === "active" || r.status === "renewed");
  // The totals moved into LeaseStats with the tiles. `expiring` stays here —
  // the banner below it is a separate call to action, not a tile.
  const expiring = live.filter((r) => r.days_to_expiry >= 0 && r.days_to_expiry <= 90);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leases & rent"
        description="The tenancy schedule — who is in which unit, until when, for how much, and what is still owed."
        actions={
          canWrite ? (
            <Button asChild variant="brand">
              <Link href="/dashboard/leases/new"><Plus /> Record a tenancy</Link>
            </Button>
          ) : undefined
        }
      />

      <LeaseStats rows={rows} />

      {expiring.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sm">
            <AlertTriangle className="size-4 flex-shrink-0 text-amber-600" />
            <span className="font-medium">
              {expiring.length} tenanc{expiring.length === 1 ? "y" : "ies"} end
              {expiring.length === 1 ? "s" : ""} within 90 days.
            </span>
            <span className="text-muted-foreground">
              Renewal notices go out automatically at 90, 60 and 30 days.
            </span>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No tenancies recorded yet"
          description={
            canWrite
              ? "Record a tenancy against a vacant unit. Rent in Nigeria is normally billed annually in advance, which is what the form assumes."
              : "Tenancies you manage will appear here."
          }
          action={
            canWrite ? (
              <Button asChild variant="brand" size="sm">
                <Link href="/dashboard/leases/new">Record a tenancy</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="px-0 pb-0">
            <RentRollTable rows={tableRows} canWrite={canWrite} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
