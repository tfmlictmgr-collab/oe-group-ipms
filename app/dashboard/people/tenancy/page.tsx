import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import TenancyApplicationLink from "../TenancyApplicationLink";
import PropertyWindows, { type PropertyWindow } from "../PropertyWindows";

// Where OEA opens and closes its own tenancy intake.
//
// Until now the window was a column only the public page read and only the
// verification script wrote — so opening applications meant someone with
// database access doing it by hand. An operational switch that lives outside
// the product is not a switch, it is a support ticket.
export default async function TenancyApplicationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();
  const [orgRes, moduleRes, queueRes, windowsRes] = await Promise.all([
    supabase
      .from("orgs")
      .select("id, tenant_applications_open")
      .eq("id", profile.org_id)
      .single(),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
    // Only the count is used, so no application rows are fetched. These carry
    // the heaviest PII in the system; pulling them to render a number would put
    // them through a page that has no business holding them.
    supabase
      .from("application_overview")
      .select("*", { count: "exact", head: true })
      .in("status", ["submitted", "under_review", "info_requested"]),
    // Per-property intake, with the vacancy behind each decision.
    supabase
      .from("property_application_windows")
      .select("property_id, name, applications_state, accepting_now, unit_count, vacant_count")
      .order("name"),
  ]);

  // Lettings is OEA-only (B9 module registry). A facilities org has no tenancies
  // to take applications for, so the page says so rather than offering a switch
  // that would do nothing.
  if (!moduleRes.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tenancy applications</CardTitle>
          <CardDescription>
            Lettings is not enabled for this organisation. Tenancy applications,
            leases and rent belong to the property side of the group.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Public tenancy application link</CardTitle>
          <CardDescription>
            Share this with prospective tenants — individual or corporate. They
            apply without an account, can save and come back, and every
            application is read by a person. Nothing here scores or ranks an
            applicant.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TenancyApplicationLink
            orgId={profile.org_id}
            isOpen={Boolean(orgRes.data?.tenant_applications_open)}
            isAdmin={profile.role === "admin"}
            origin={origin}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Which properties are taking applications</CardTitle>
          <CardDescription>
            <strong>Auto</strong> follows occupancy — a property is open while it
            has a vacant unit. Override it to keep a waiting list on a full
            property, or to close one that is being refurbished. The override is
            recorded against your name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PropertyWindows
            rows={(windowsRes.data ?? []) as PropertyWindow[]}
            isAdmin={profile.role === "admin" || profile.role === "executive"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Applications received
            {(queueRes.count ?? 0) > 0 && (
              <Badge variant="brand">{queueRes.count}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {(queueRes.count ?? 0) === 0
              ? "Nothing waiting. Submitted applications appear here."
              : "Waiting to be reviewed."}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
