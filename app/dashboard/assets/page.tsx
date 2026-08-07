import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Download, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleAbbrev } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../RoleGate";
import AssetList, { type AssetRow } from "./AssetList";

export default async function AssetsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Owners, finance and oversight can read the register; only admin + FM/PM may
  // write. `executive` holds `assets.read` in the seeded matrix and nothing
  // further — `canWrite` below already excludes them, so the New/Import buttons
  // stay hidden and their own pages refuse independently.
  if (
    !roleAllowed(session.profile?.role, [
      "admin",
      "facility_manager",
      "finance_approver",
      "property_owner",
      "executive",
    ])
  ) {
    return <RoleGate title="Asset Register" />;
  }

  const canWrite = ["admin", "facility_manager"].includes(session.profile?.role ?? "");
  const who = roleAbbrev("facility_manager", session.org?.delivery_brand);

  const supabase = await createClient();
  const { data } = await supabase
    .from("assets")
    .select(
      "id, asset_tag, name, category, status, condition, criticality, manufacturer, model, serial_number, location_detail, next_service_due, certificate_expiry, insurance_expiry, compliance_required, properties!assets_property_id_fkey(name)"
    )
    .order("asset_tag");

  const assets = (data as unknown as AssetRow[]) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Asset Register"
        description={`Plant, equipment and fabric across your properties. Maintained by the ${who}.`}
        actions={
          canWrite ? (
            <>
              <Button asChild variant="outline" size="sm">
                {/* Plain anchor: this is a file download, not a route change. */}
                <a href="/api/assets/template" download>
                  <Download /> Template
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/assets/import">
                  <Upload /> Bulk import
                </Link>
              </Button>
              <Button asChild variant="brand" size="sm">
                <Link href="/dashboard/assets/new">
                  <Plus /> Add asset
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <AssetList assets={assets} />
    </div>
  );
}
