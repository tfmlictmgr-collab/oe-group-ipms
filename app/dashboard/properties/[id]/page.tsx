import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MapPin, Package } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import UnitsPanel from "./UnitsPanel";
import StakeholderPanel from "./StakeholderPanel";

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
    { data: members },
    { data: stakeholders },
    { count: assetCount },
    { data: canWrite },
  ] = await Promise.all([
    supabase.from("units")
      .select("id, label, apportionment_factor, occupant_user_id")
      .eq("property_id", id)
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
  ]);

  const allMembers = (members ?? []) as {
    id: string; full_name: string | null; email: string | null; role: string;
  }[];

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
          occupant_user_id: u.occupant_user_id,
        }))}
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
              .filter((m) => ["facility_manager", "property_owner"].includes(m.role))
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
    </div>
  );
}
