import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { AppShell } from "@/components/shell/app-shell";
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
  const roleLabel = role.replace(/_/g, " ");

  const ctx: NavContext = {
    isStaff: ["admin", "facility_manager", "finance_approver"].includes(role),
    isAdmin: role === "admin",
    seesAudit: role === "admin" || role === "finance_approver",
    // B7 "Exec / BI dashboard" column
    seesBi: ["admin", "facility_manager", "finance_approver", "property_owner"].includes(role),
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
          roleLabel,
        }}
        ctx={ctx}
      >
        {children}
      </AppShell>
    </div>
  );
}
