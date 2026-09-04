import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { Inbox } from "lucide-react";
import TenancyApplicationLink from "../TenancyApplicationLink";
import PropertyWindows, { type PropertyWindow } from "../PropertyWindows";

const STATUS_LABEL: Record<string, string> = {
  submitted: "New",
  under_review: "Under review",
  info_requested: "Awaiting applicant",
  approved: "Approved",
  rejected: "Rejected",
};
const STATUS_VARIANT: Record<string, "brand" | "outline" | "success" | "destructive"> = {
  submitted: "brand",
  under_review: "outline",
  info_requested: "outline",
  approved: "success",
  rejected: "destructive",
};

// Where OEA opens and closes its own tenancy intake.
//
// Until now the window was a column only the public page read and only the
// verification script wrote — so opening applications meant someone with
// database access doing it by hand. An operational switch that lives outside
// the product is not a switch, it is a support ticket.
export default async function TenancyApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  // Newest first by default. "Oldest" stays reachable because a review queue is
  // legitimately worked FIFO — the application waiting longest is the one an
  // applicant is most likely to be chasing.
  const sortNewest = (await searchParams).sort !== "oldest";
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();
  const [orgRes, moduleRes, queueRes, windowsRes] = await Promise.all([
    supabase
      .from("orgs")
      .select("id, slug, tenant_applications_open")
      .eq("id", profile.org_id)
      .single(),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
    // The Day 8 review queue. `application_overview` never selects `sensitive`
    // — special-category data does not reach this page, or any reviewer's.
    supabase
      .from("application_overview")
      .select(
        "id, type, status, applicant_name, property_id, recommendation, approvals_count, approvals_needed, submitted_at, created_at"
      )
      .in("status", ["submitted", "under_review", "info_requested"])
      // ⚠️ `nullsFirst` follows the direction rather than being pinned. A
      // submitted_at of NULL is a draft that has not been sent, and it belongs
      // at the END of a newest-first list, not stranded at the top of it.
      .order("submitted_at", { ascending: !sortNewest, nullsFirst: !sortNewest }),
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

  const applications = (queueRes.data ?? []) as {
    id: string;
    type: "individual" | "corporate";
    status: string;
    applicant_name: string;
    property_id: string | null;
    recommendation: string | null;
    approvals_count: number;
    approvals_needed: number;
    submitted_at: string | null;
    created_at: string;
  }[];
  const propertyNames = new Map(
    (windowsRes.data ?? []).map((p) => [p.property_id, p.name])
  );

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
            slug={orgRes.data?.slug}
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                Applications received
                {applications.length > 0 && <Badge variant="brand">{applications.length}</Badge>}
              </CardTitle>
              <CardDescription>
                {sortNewest ? "Newest first" : "Oldest first"}. Each one is read by
                a person, never scored or ranked.
              </CardDescription>
            </div>
            {/* Links rather than a control with state: this page is server
                rendered, so the order is decided by the query and survives a
                refresh, a bookmark and a shared URL. */}
            <div className="flex flex-shrink-0 gap-1 text-xs">
              {([["newest", "Newest first"], ["oldest", "Oldest first"]] as const).map(
                ([key, label]) => (
                  <Link
                    key={key}
                    href={`/dashboard/people/tenancy?sort=${key}`}
                    aria-current={(key === "newest") === sortNewest ? "true" : undefined}
                    className={
                      (key === "newest") === sortNewest
                        ? "rounded-full bg-[var(--brand)] px-2.5 py-1 font-medium text-[var(--brand-fg)]"
                        : "rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:bg-accent"
                    }
                  >
                    {label}
                  </Link>
                )
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="Nothing waiting"
              description="Submitted applications appear here as they arrive."
            />
          ) : (
            <ul className="divide-y divide-border">
              {applications.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/dashboard/people/tenancy/${a.id}`}
                    className="flex items-center justify-between gap-3 py-3 transition-colors hover:bg-accent/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.applicant_name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {propertyNames.get(a.property_id ?? "") ?? "No property"}
                        {" · "}
                        {a.type === "corporate" ? "Business" : "Individual"}
                        {a.status === "under_review" &&
                          ` · ${a.approvals_count}/${a.approvals_needed} approvals`}
                        {a.recommendation &&
                          a.status === "under_review" &&
                          ` · recommended ${a.recommendation}`}
                      </p>
                    </div>
                    <Badge variant={STATUS_VARIANT[a.status] ?? "outline"} className="flex-shrink-0">
                      {STATUS_LABEL[a.status] ?? a.status}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
