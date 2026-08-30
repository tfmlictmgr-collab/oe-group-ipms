import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Handshake } from "lucide-react";
import ReviewPanel from "./ReviewPanel";

/**
 * The staff side of 0165 — packs offered here from elsewhere on the
 * platform. The vendor-facing offer/withdraw half lives on their own
 * "Contracts & introductions" section of My Company.
 *
 * ⚠️ Deliberately named nowhere here: which organisation an offer came
 * from. `pending_vendor_introductions()` withholds it by construction —
 * "this contractor holds an approved registration elsewhere on the platform
 * and has consented to share it with you", not with whom. Naming the source
 * needs a recorded board exception to B1 (0165's own header); this screen
 * must not reconstruct that disclosure by showing anything the function
 * did not return.
 */
export default async function VendorIntroductionsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  // Same capability as verifying a registration pack (vendors/registrations) —
  // taking on a company IS registering one, just with the pack pre-filled.
  const { data: canReview } = await supabase.rpc("has_permission", {
    p_capability: "vendors.write",
  });
  if (!canReview) {
    return (
      <EmptyState
        icon={<Handshake />}
        title="Not yours to review"
        description="Taking on a contractor's registration needs the vendor-management permission. An administrator can grant it."
      />
    );
  }

  const { data: rows } = await supabase.rpc("pending_vendor_introductions");
  const offers = (rows ?? []) as {
    id: string;
    business_name: string;
    service_category: string | null;
    cac_number: string | null;
    tin: string | null;
    tier: string;
    document_count: number;
    offered_at: string;
    expires_at: string;
  }[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contractor introductions"
        description="Registrations a contractor has consented to carry here from elsewhere on the platform. Accepting takes on their pack for your own verification — it does not approve it."
      />

      {offers.length === 0 ? (
        <EmptyState
          icon={<Handshake />}
          title="Nothing waiting"
          description="Offers appear here when a contractor already approved elsewhere on the platform consents to carry their registration to you."
        />
      ) : (
        <div className="space-y-4">
          {offers.map((o) => (
            <Card key={o.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{o.business_name}</CardTitle>
                    <CardDescription>
                      {o.service_category ?? "—"} · {o.document_count} document
                      {o.document_count === 1 ? "" : "s"} carried over · offered{" "}
                      {new Date(o.offered_at).toLocaleDateString("en-GB", {
                        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
                      })}
                      {" · open until "}
                      {new Date(o.expires_at).toLocaleDateString("en-GB", {
                        timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric",
                      })}
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="capitalize">{o.tier}</Badge>
                </div>
                {(o.cac_number || o.tin) && (
                  <p className="text-xs text-muted-foreground">
                    {o.cac_number && `CAC ${o.cac_number}`}
                    {o.cac_number && o.tin && " · "}
                    {o.tin && `TIN ${o.tin}`}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <ReviewPanel id={o.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
