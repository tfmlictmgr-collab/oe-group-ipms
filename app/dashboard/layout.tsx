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

  return (
    <div className="min-h-screen" style={{ background: theme.surface }}>
      <header
        className="flex items-center justify-between px-6 py-3"
        style={{ background: theme.primary, color: theme.primaryForeground }}
      >
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold"
              style={{ background: theme.accent, color: theme.primaryForeground }}
            >
              OE
            </span>
            <span className="text-sm font-semibold">{theme.name} · Portal</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="opacity-80 hover:opacity-100">
              Requests
            </Link>
            {isStaff && (
              <>
                <Link
                  href="/dashboard/vendors"
                  className="opacity-80 hover:opacity-100"
                >
                  Vendors
                </Link>
                <Link
                  href="/dashboard/sc"
                  className="opacity-80 hover:opacity-100"
                >
                  Service Charges
                </Link>
                <Link
                  href="/dashboard/payments"
                  className="opacity-80 hover:opacity-100"
                >
                  Payments
                </Link>
              </>
            )}
            <Link
              href="/dashboard/statements"
              className="opacity-80 hover:opacity-100"
            >
              Statements
            </Link>
            {profile?.role === "admin" && (
              <Link
                href="/dashboard/settings"
                className="opacity-80 hover:opacity-100"
              >
                Settings
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right leading-tight">
            <div className="text-sm font-medium">
              {profile?.full_name ?? profile?.email}
            </div>
            <div className="text-xs capitalize opacity-80">
              {roleLabel} · {org?.name}
            </div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
    </div>
  );
}
