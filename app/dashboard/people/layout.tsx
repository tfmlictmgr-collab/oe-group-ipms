import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import RoleGate, { roleAllowed } from "../RoleGate";
import SubNav from "./SubNav";
import { FM_PM } from "@/lib/roles";

// Shared chrome for the People section. The counts are computed once here so
// every sub-page shows the same figures and each page stays focused on one job.
export default async function PeopleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  // ⚠️ `regional_manager` is named explicitly rather than folded into `FM_PM`,
  // whose own comment forbids that: several call sites include the regional
  // manager and several deliberately do not, so widening the constant would
  // silently widen the ones that do not.
  //
  // It belongs here because the DATABASE has always allowed it and only this
  // gate refused. `0183`'s invitation and vendor-decision functions all test
  // `current_user_role() not in ('admin','facility_manager','property_manager',
  // 'regional_manager')`, and `people.invite` is granted to the regional
  // manager in the B7 baseline (`seed_b7_permissions`). Decision 9 gives them
  // "inviting operational staff, bounded to the region they are assigned to" —
  // and the product refused them the only screen that does it, while the nav
  // went on offering the link. A menu item that leads to "Not available for
  // your role" is the UI disagreeing with the policy, and the policy was right.
  if (!roleAllowed(session.profile?.role, ["admin", ...FM_PM, "regional_manager"])) {
    return <RoleGate title="People & Onboarding" />;
  }

  const supabase = await createClient();
  const [invites, apps, lettings, tenancyApps] = await Promise.all([
    supabase
      .from("invitations")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("vendor_applications")
      .select("*", { count: "exact", head: true })
      .in("status", ["submitted", "email_verified", "under_review"]),
    supabase.rpc("org_has_module", {
      p_org_id: session.profile!.org_id,
      p_module: "lettings",
    }),
    supabase
      .from("application_overview")
      .select("*", { count: "exact", head: true })
      .in("status", ["submitted", "under_review", "info_requested"]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="People &amp; Onboarding"
        description="Invite staff, vendors and tenants, and set what each of them can reach."
      />
      <SubNav
        counts={{
          invites: invites.count ?? 0,
          apps: apps.count ?? 0,
          tenancy: tenancyApps.count ?? 0,
        }}
        modules={{ lettings: Boolean(lettings.data) }}
      />
      {children}
    </div>
  );
}
