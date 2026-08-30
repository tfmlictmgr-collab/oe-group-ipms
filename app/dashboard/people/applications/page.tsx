import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import ApplicationQueue, { type Application } from "../ApplicationQueue";
import ApplicationLink from "../ApplicationLink";
import { VendorApprovals } from "../PendingList";

export default async function ApplicationsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();
  const [appsRes, orgRes, pendingVendorsRes, canRecommendRes, canApproveRes] =
    await Promise.all([
    supabase
      .from("vendor_applications")
      .select(
        "id, business_name, service_category, cac_number, tin, contact_name, contact_email, contact_phone, website, notes, status, email_verified_at, created_at, recommended_by, recommendation_notes"
      )
      .in("status", ["submitted", "email_verified", "under_review"])
      .order("created_at", { ascending: false }),
    supabase
      .from("orgs")
      .select("id, vendor_applications_open")
      .eq("id", profile.org_id)
      .single(),
    supabase
      .from("vendors")
      .select("id, name, service_category, contact_email")
      .eq("approval_status", "pending")
      .order("created_at", { ascending: false }),
    // 0238. Asked of the database rather than inferred from the role, so the
    // buttons on screen agree with what the function will actually permit.
    supabase.rpc("has_permission", { p_capability: "vendors.recommend" }),
    supabase.rpc("has_permission", { p_capability: "vendors.approve" }),
  ]);

  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Public application link</CardTitle>
          <CardDescription>
            Share this so vendors can apply themselves. Every application is
            reviewed by a person — approving one creates the vendor record, and
            nothing can be assigned or paid before that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApplicationLink
            orgId={profile.org_id}
            isOpen={Boolean(orgRes.data?.vendor_applications_open)}
            isAdmin={profile.role === "admin"}
            origin={origin}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Applications to review</CardTitle>
        </CardHeader>
        <CardContent>
          <ApplicationQueue
            applications={(appsRes.data as Application[]) ?? []}
            canRecommend={Boolean(canRecommendRes.data)}
            canApprove={Boolean(canApproveRes.data)}
            me={session.user.id}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vendors awaiting approval</CardTitle>
          <CardDescription>
            A vendor can&apos;t be assigned work or paid until approved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VendorApprovals vendors={pendingVendorsRes.data ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}
