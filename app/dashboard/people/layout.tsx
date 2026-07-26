import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import RoleGate, { roleAllowed } from "../RoleGate";
import SubNav from "./SubNav";

// Shared chrome for the People section. The counts are computed once here so
// every sub-page shows the same figures and each page stays focused on one job.
export default async function PeopleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!roleAllowed(session.profile?.role, ["admin", "facility_manager"])) {
    return <RoleGate title="People & Onboarding" />;
  }

  const supabase = await createClient();
  const [invites, apps] = await Promise.all([
    supabase
      .from("invitations")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("vendor_applications")
      .select("*", { count: "exact", head: true })
      .in("status", ["submitted", "email_verified", "under_review"]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="People &amp; Onboarding"
        description="Invite staff, vendors and tenants, and set what each of them can reach."
      />
      <SubNav counts={{ invites: invites.count ?? 0, apps: apps.count ?? 0 }} />
      {children}
    </div>
  );
}
