import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";
import { roleLabel } from "@/lib/roles";
import type { NavContext } from "@/components/shell/nav-config";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const { profile, org, theme } = session;
  const role = profile?.role ?? "member";
  // Brand-aware: OEA renders facility_manager as "Properties Manager".
  const label = roleLabel(role, org?.delivery_brand);

  // RLS restricts this to the caller's own rows — no role logic needed here.
  const supabase = await createClient();
  const { data: notifications } = await supabase
    .from("user_notifications")
    .select("id, kind, title, body, link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  // A viewer is outside the organisation, so it is listed in none of the sets
  // below rather than added to any of them. The nav is presentation; RLS is what
  // actually decides, and 0038 grants a viewer no policy on any of these tables.
  const ctx: NavContext = {
    isStaff: ["admin", "facility_manager", "finance_approver"].includes(role),
    isAdmin: role === "admin",
    isViewer: role === "viewer",
    seesAudit: role === "admin" || role === "finance_approver",
    // B7 "Exec / BI dashboard" column
    seesBi: ["admin", "facility_manager", "finance_approver", "property_owner"].includes(role),
    seesAssets: ["admin", "facility_manager", "finance_approver", "property_owner"].includes(role),
    canEnroll: ["admin", "facility_manager"].includes(role),
    seesLedger: ["admin", "finance_approver"].includes(role),
  };

  return (
    <div
      style={
        {
          "--brand": theme.primary,
          "--brand-fg": theme.primaryForeground,
          "--brand-accent": theme.accent,
        } as React.CSSProperties
      }
    >
      <AppShell
        brandName={theme.name}
        orgName={org?.name ?? theme.name}
        logoText={theme.logoText}
        logoUrl={theme.logoUrl}
        portalName={theme.portalName}
        supportEmail={theme.supportEmail}
        supportPhone={theme.supportPhone}
        user={{
          name: profile?.full_name ?? profile?.email ?? "",
          email: profile?.email ?? "",
          roleLabel: label,
        }}
        ctx={ctx}
        notifications={notifications ?? []}
      >
        {children}
      </AppShell>
    </div>
  );
}
