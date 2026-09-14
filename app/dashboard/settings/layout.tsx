import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import SettingsNav from "./SettingsNav";

// Shared chrome for Settings. The section itself is open to everyone because
// personal notification preferences live here; the organisation-configuration
// tabs are filtered out for non-admins, and each of those pages re-checks the
// role server-side rather than relying on the nav being hidden.
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const isAdmin = session.profile?.role === "admin";

  return (
    <div className="space-y-6">
      {/* Heading and tabs pin together (globals.css, `data-section-head`). */}
      <div
        data-section-head
        className="-mx-4 -my-3 space-y-6 bg-background px-4 py-3 sm:-mx-6 sm:px-6"
      >
        <PageHeader
          title="Settings"
          description={
            isAdmin
              ? "Organisation configuration and your own preferences."
              : "Your account and how we reach you."
          }
        />
        <SettingsNav isAdmin={isAdmin} />
      </div>
      {children}
    </div>
  );
}
