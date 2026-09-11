import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import RoleGate, { roleAllowed } from "../RoleGate";
import RaiseWorkForm, { type Option } from "./RaiseWorkForm";
import { FM_PM } from "@/lib/roles";

// Work an FM/PM initiates, rather than work a tenant reports.
//
// Every existing route into `tickets` assumed a reporter — the chat webhooks
// carry a sender, and `/dashboard/new` files the signed-in person's own unit
// against their own name. Planned maintenance, an inspection finding, or
// anything spotted on a walk-round had nowhere to go.

export const dynamic = "force-dynamic";

export default async function RaiseWorkPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  if (!roleAllowed(session.profile?.role, [
    "admin", ...FM_PM, "regional_manager",
  ])) {
    return <RoleGate title="Raise work" />;
  }

  const supabase = await createClient();

  // Everything here is read under the caller's own RLS, so the pickers can
  // only ever offer what `raise_work_order` would accept — properties they
  // hold, assets on those properties, vendors in their org.
  const [{ data: props }, { data: assets }, { data: units }, { data: vendors }] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("assets").select("id, name, asset_tag, property_id").order("name"),
    // 0273. Same RLS as everything else here — `units_select` admits a
    // property-scoped reader, so this can only ever list units on properties
    // they already hold.
    supabase.from("units").select("id, label, property_id").order("label"),
    supabase.from("vendors").select("id, name").order("name"),
  ]);

  const properties: Option[] = (props ?? []).map((p) => ({ id: p.id, label: p.name }));
  const assetOptions: Option[] = (assets ?? []).map((a) => ({
    id: a.id,
    label: a.asset_tag ? `${a.name} (${a.asset_tag})` : a.name,
    propertyId: a.property_id as string,
  }));
  const unitOptions: Option[] = (units ?? []).map((u) => ({
    id: u.id,
    label: u.label,
    propertyId: u.property_id as string,
  }));
  const vendorOptions: Option[] = (vendors ?? []).map((v) => ({ id: v.id, label: v.name }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Raise work"
        description="Planned maintenance, an inspection finding, anything you have spotted."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard"><ArrowLeft /> Back</Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-6">
          <RaiseWorkForm
            properties={properties}
            assets={assetOptions}
            units={unitOptions}
            vendors={vendorOptions}
          />
        </CardContent>
      </Card>
    </div>
  );
}
