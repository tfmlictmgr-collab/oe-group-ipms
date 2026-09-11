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

  // ⚠️ Vacancy is the database's rule, not this file's (0200/0201). Counting
  // `occupant_user_id` alone — which this screen did — calls a unit let to a
  // company with no portal user "vacant", while the property register, the
  // intake window and the lease form all correctly call it let. One rule, asked
  // once for every property rather than once per property.
  const { data: vacantRows } = await supabase.rpc("vacant_unit_ids", {
    p_property_ids: props.map((p) => p.id),
  });
  const vacantIds = new Set((vacantRows ?? []).map((r: { unit_id: string }) => r.unit_id));

  const units = (unitsRes.data ?? [])
    .filter((u) => writableIds.has(u.property_id))
    .map((u) => ({
      id: u.id,
      label: u.label,
      property: (u.properties as unknown as { name: string } | null)?.name ?? "—",
      occupantId: u.occupant_user_id,
      occupantName: u.occupant_user_id ? memberById.get(u.occupant_user_id) ?? null : null,
      isVacant: vacantIds.has(u.id),
    }));

  const occupied = units.filter((u) => !u.isVacant).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Unit occupancy</CardTitle>
        <CardDescription>
          {occupied} of {units.length} units occupied. Assigning a tenant is what
          links their requests and service-charge statements to the right
          property. A unit under a live tenancy counts as occupied even where no
          occupant has been recorded against it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UnitAssign units={units} tenants={tenants} />
      </CardContent>
    </Card>
  );
}
