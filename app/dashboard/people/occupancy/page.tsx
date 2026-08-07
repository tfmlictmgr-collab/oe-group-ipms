import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { writableProperties } from "../../assets/actions";
import UnitAssign from "../UnitAssign";

export default async function OccupancyPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const [membersRes, unitsRes, props] = await Promise.all([
    supabase.from("users").select("id, full_name, email, role, deactivated_at").order("full_name"),
    supabase
      .from("units")
      .select("id, label, property_id, occupant_user_id, properties!units_property_id_fkey(name)")
      .order("label"),
    writableProperties(),
  ]);

  const members = membersRes.data ?? [];
  const memberById = new Map(members.map((m) => [m.id, m.full_name ?? m.email ?? "User"]));
  // A deactivated person can't be assigned to a unit.
  const tenants = members
    .filter((m) => m.role === "tenant" && !m.deactivated_at)
    .map((m) => ({ id: m.id, label: m.full_name ?? m.email ?? "Tenant" }));

  const writableIds = new Set(props.map((p) => p.id));
  const units = (unitsRes.data ?? [])
    .filter((u) => writableIds.has(u.property_id))
    .map((u) => ({
      id: u.id,
      label: u.label,
      property: (u.properties as unknown as { name: string } | null)?.name ?? "—",
      occupantId: u.occupant_user_id,
      occupantName: u.occupant_user_id ? memberById.get(u.occupant_user_id) ?? null : null,
    }));

  const occupied = units.filter((u) => u.occupantId).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Unit occupancy</CardTitle>
        <CardDescription>
          {occupied} of {units.length} units occupied. Assigning a tenant is what
          links their requests and service-charge statements to the right property.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UnitAssign units={units} tenants={tenants} />
      </CardContent>
    </Card>
  );
}
