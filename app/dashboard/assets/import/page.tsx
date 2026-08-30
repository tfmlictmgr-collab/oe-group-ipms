import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../../RoleGate";
import { buildImportContext } from "../actions";
import ImportClient from "./ImportClient";
import { FM_PM } from "@/lib/roles";

export default async function AssetImportPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  // ⚠️ `regional_manager` named explicitly, NOT folded into FM_PM — that
  // constant's own comment forbids it, because several call sites include the
  // regional manager and several deliberately do not. It belongs here because
  // they hold the capability this page is for (0236/0238); the nav offers the
  // link from that capability and only this list said no.
  if (!roleAllowed(session.profile?.role, ["admin", ...FM_PM, "regional_manager"])) {
    return <RoleGate title="Bulk import assets" />;
  }

  // Lookups are built from what the CALLER can see, so a property they don't
  // manage never enters the map and any row naming it fails validation.
  const { ctx, propertyNames } = await buildImportContext();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Bulk import assets"
        description="Prepare your register offline, then upload it. You'll see exactly what will be created before anything is saved."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/assets">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <ImportClient rawCtx={ctx} propertyNames={propertyNames} />
    </div>
  );
}
