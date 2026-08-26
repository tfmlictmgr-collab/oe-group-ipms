import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MapPin, Package } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel, FM_PM } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import UnitsPanel from "./UnitsPanel";
import StakeholderPanel from "./StakeholderPanel";
import VendorPropertiesPanel from "./VendorPropertiesPanel";

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();

  const { data: property } = await supabase
    .from("properties")
    .select("id, name, reference, address, property_type")
    .eq("id", id)
    .maybeSingle();

  // A property outside the caller's scope and one that does not exist are
  // answered identically — RLS has already filtered it.
  if (!property) notFound();

  const [
    { data: units },
    { data: unitTypes },
    { data: members },
    { data: stakeholders },
    { count: assetCount },
    { data: canWrite },
    { data: vendors },
    { data: vendorProperties },
    { data: vacantUnits },
  ] = await Promise.all([
    supabase.from("units")
      .select("id, label, apportionment_factor, unit_quantity, description, occupant_user_id")
      .eq("property_id", id)
      .order("label"),
    // Platform standards plus this org's own additions — the RLS policy on
    // unit_types (0198) decides which rows come back, so no org filter is
    // needed or wanted here.
    supabase.from("unit_types")
      .select("id, label, category")
      .is("deleted_at", null)
      .order("label"),
    supabase.from("users")
      .select("id, full_name, email, role")
      .is("deactivated_at", null)
      .order("full_name"),
    supabase.from("property_stakeholders")
      .select("user_id, relation")
      .eq("property_id", id),
    supabase.from("assets")
      .select("id", { count: "exact", head: true })
      .eq("property_id", id),
    supabase.rpc("has_permission", { p_capability: "properties.write" }),
    // The directory stays org-visible to whoever may dispatch work (0012) —
    // this is the standing list to pick FROM, not what is already attached.
    supabase.from("vendors").select("id, name").order("name"),
    supabase.from("vendor_properties").select("vendor_id").eq("property_id", id),
    // Vacancy is asked of the database rather than inferred from the occupant
    // column, because the occupant column is only half the rule (0200): a unit
    // held by a live tenancy that never wrote an occupant is not free, and this
    // panel is where someone decides whether to let it.
    supabase.rpc("vacant_units_for_property", { p_property_id: id }),
  ]);

  const allMembers = (members ?? []) as {
    id: string; full_name: string | null; email: string | null; role: string;
  }[];
  const vacantIds = new Set(
    ((vacantUnits ?? []) as { id: string }[]).map((u) => u.id)
  );

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/properties"><ArrowLeft className="size-4" /> All properties</Link>
      </Button>

      <PageHeader
        title={property.name}
        description={
          [property.reference, property.property_type].filter(Boolean).join(" · ") || undefined
        }
        actions={
          canWrite ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/properties/${id}/edit`}>Edit details</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        {property.address && (
          <span className="flex items-center gap-1.5">
            <MapPin className="size-4" /> {property.address}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Package className="size-4" /> {assetCount ?? 0} asset
          {(assetCount ?? 0) === 1 ? "" : "s"} on the register
        </span>
      </div>

      <UnitsPanel
        propertyId={id}
        units={(units ?? []).map((u) => ({
          id: u.id, label: u.label,
          apportionment_factor: u.apportionment_factor,
          unit_quantity: u.unit_quantity,
          description: u.description,
          occupant_user_id: u.occupant_user_id,
          is_vacant: vacantIds.has(u.id),
        }))}
        unitTypes={(unitTypes ?? []) as { id: string; label: string; category: "residential" | "commercial" }[]}
        // Occupants are tenants; offering staff would create nonsense records.
        members={allMembers.filter((m) => m.role === "tenant")}
        canWrite={Boolean(canWrite)}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Who is attached to this property</CardTitle>
          <CardDescription>
            The attaché assignment. It decides which properties an FM/PM or owner
            can see and act on — not a label, the actual access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StakeholderPanel
            propertyId={id}
            brand={session.org?.delivery_brand ?? null}
            candidates={allMembers
              .filter((m) => [...FM_PM, "property_owner"].includes(m.role))
              .map((m) => ({
                id: m.id,
                name: m.full_name ?? m.email ?? "Unnamed",
                role: m.role,
                roleName: roleLabel(m.role, session.org?.delivery_brand ?? null),
              }))}
            attached={(stakeholders ?? []).map((s) => ({
              userId: s.user_id, relation: s.relation as "manager" | "owner",
            }))}
            canWrite={Boolean(canWrite)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Contractors working this property</CardTitle>
          <CardDescription>
            A standing association, separate from any one job — it decides which
            vendors&apos; payments and evaluations this property&apos;s FM/PM may see.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VendorPropertiesPanel
            propertyId={id}
            vendors={(vendors ?? []) as { id: string; name: string }[]}
            attachedVendorIds={(vendorProperties ?? []).map((v) => v.vendor_id)}
            canWrite={Boolean(canWrite)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
