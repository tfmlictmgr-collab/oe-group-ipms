import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Inbox, Download } from "lucide-react";
import ReviewPanel from "./ReviewPanel";

/**
 * The staff side of vendor registration — the review queue
 * `VENDOR_SELF_SERVICE_SCOPE.md` §6 listed as owed.
 *
 * ⚠️ The receiving organisation verifies and approves for ITSELF, including
 * for a vendor introduced from the other brand (decision 17): an introduction
 * arrives as a COPY at `submitted`, and verification status, machine findings
 * and source-org user ids do not cross. So there is nothing special-cased here
 * about where a pack came from — every submitted pack is reviewed the same way,
 * which is the point.
 */
export default async function VendorRegistrationsPage() {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) redirect("/login");
  const { profile, org } = session;
  const isOperator = profile.role === "admin" && Boolean(org.is_platform_operator);

  const supabase = await createClient();

  // `vendors.write` is what governs verifying a pack — the same capability that
  // governs adding a vendor at all. RLS refuses regardless; this keeps the page
  // from rendering an empty shell to someone who simply may not review.
  const [{ data: canReview }, { data: exportGranted }] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "vendors.write" }),
    // 0223 — off for everyone but the operator until turned on for this org's
    // admin, same gate as the tenancy application's document zip.
    profile.role === "admin" && !isOperator
      ? supabase.rpc("has_permission", { p_capability: "records.export" })
      : Promise.resolve({ data: false }),
  ]);
  const canDownloadDocs = isOperator || Boolean(exportGranted);
  if (!canReview) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Not yours to review"
        description="Verifying a contractor's registration needs the vendor-management permission. An administrator can grant it."
      />
    );
  }

  const { data: rows } = await supabase
    .from("vendor_registrations")
    .select(
      "vendor_id, tier, status, legal_name, trading_name, cac_number, tin, address, city, state, phone, email, bank_name, account_name, account_number_last4, submitted_at, review_notes, vendors(name)"
    )
    .in("status", ["submitted", "changes_requested"])
    .order("submitted_at", { ascending: true });

  const packs = (rows ?? []) as unknown as {
    vendor_id: string;
    tier: string;
    status: string;
    legal_name: string | null;
    trading_name: string | null;
    cac_number: string | null;
    tin: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    phone: string | null;
    email: string | null;
    bank_name: string | null;
    account_name: string | null;
    account_number_last4: string | null;
    submitted_at: string | null;
    review_notes: string | null;
    vendors: { name: string } | null;
  }[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contractor registrations"
        description="Packs waiting to be verified. Check each document against what the company has stated, then approve or send it back saying what is wrong."
      />

      {packs.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="Nothing waiting"
          description="Registrations appear here when a contractor sends their pack for review."
        />
      ) : (
        <div className="space-y-4">
          {packs.map((p) => (
            <Card key={p.vendor_id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {p.vendors?.name ?? p.legal_name ?? "Unnamed contractor"}
                    </CardTitle>
                    <CardDescription>
                      {p.legal_name && p.legal_name !== p.vendors?.name
                        ? `Registered as ${p.legal_name} · `
                        : ""}
                      {p.submitted_at
                        ? `Submitted ${new Date(p.submitted_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" })}`
                        : "Not yet submitted"}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize">{p.tier}</Badge>
                    <Badge variant={p.status === "submitted" ? "warning" : "muted"}>
                      {p.status === "submitted" ? "Awaiting review" : "Changes requested"}
                    </Badge>
                    {canDownloadDocs && (
                      <Button asChild variant="outline" size="sm">
                        <a href={`/api/records/documents-zip?type=vendor&id=${p.vendor_id}`} download>
                          <Download className="size-4" /> All docs
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ReviewPanel
                  vendorId={p.vendor_id}
                  stated={{
                    "CAC number": p.cac_number,
                    TIN: p.tin,
                    Address: [p.address, p.city, p.state].filter(Boolean).join(", ") || null,
                    Phone: p.phone,
                    Email: p.email,
                    Bank: p.bank_name,
                    "Account name": p.account_name,
                    "Account (last 4)": p.account_number_last4
                      ? `••••${p.account_number_last4}`
                      : null,
                  }}
                  previousNotes={p.review_notes}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
