import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionProfile } from "@/lib/auth";
import SignOutButton from "./SignOutButton";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const { profile, org, theme } = session;
  const roleLabel = (profile?.role ?? "member").replace(/_/g, " ");
  const isStaff = ["admin", "facility_manager", "finance_approver"].includes(
    profile?.role ?? ""
  );
  const isAdmin = profile?.role === "admin";
  const seesAudit = isAdmin || profile?.role === "finance_approver";
  // B7 "Exec / BI dashboard" column
  const seesBi = ["admin", "facility_manager", "finance_approver", "property_owner"].includes(
    profile?.role ?? ""
  );

  const navLink = "whitespace-nowrap py-1 opacity-80 transition-opacity hover:opacity-100";

  return (
    <div
      className="min-h-screen overflow-x-hidden"
      style={
        {
          background: theme.surface,
          // Drives .btn-brand / .chip-brand-active / .ring-brand so primary
          // actions inherit the org's brand colour.
          "--brand": theme.primary,
          "--brand-fg": theme.primaryForeground,
          "--brand-accent": theme.accent,
        } as React.CSSProperties
      }
    >
      <header style={{ background: theme.primary, color: theme.primaryForeground }}>
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          {/* Top row: brand + identity */}
          <div className="flex items-center justify-between gap-3 py-3">
            <Link
              href="/dashboard"
              className="flex min-w-0 items-center gap-2"
            >
              <span
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold"
                style={{
                  background: theme.accent,
                  color: theme.primaryForeground,
                }}
              >
                OE
              </span>
              <span className="truncate text-sm font-semibold">
                {theme.name}
                <span className="hidden sm:inline"> · Portal</span>
              </span>
            </Link>

            <div className="flex min-w-0 flex-shrink items-center gap-3">
              <div className="min-w-0 text-right leading-tight">
                <div className="truncate text-sm font-medium">
                  {profile?.full_name ?? profile?.email}
                </div>
                <div className="truncate text-xs capitalize opacity-80">
                  {roleLabel}
                  <span className="hidden sm:inline"> · {org?.name}</span>
                </div>
              </div>
              <SignOutButton />
            </div>
          </div>

          {/* Nav wraps rather than scrolling, so no destination is ever hidden
              off-screen on narrow viewports. */}
          <nav className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-sm">
            <Link href="/dashboard" className={navLink}>
              Requests
            </Link>
            {seesBi && (
              <Link href="/dashboard/bi" className={navLink}>
                Dashboard
              </Link>
            )}
            {isStaff && (
              <>
                <Link href="/dashboard/vendors" className={navLink}>
                  Vendors
                </Link>
                <Link href="/dashboard/sc" className={navLink}>
                  Service Charges
                </Link>
                <Link href="/dashboard/payments" className={navLink}>
                  Payments
                </Link>
              </>
            )}
            <Link href="/dashboard/statements" className={navLink}>
              Statements
            </Link>
            {seesAudit && (
              <Link href="/dashboard/audit" className={navLink}>
                Audit
              </Link>
            )}
            {isAdmin && (
              <Link href="/dashboard/settings" className={navLink}>
                Settings
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
