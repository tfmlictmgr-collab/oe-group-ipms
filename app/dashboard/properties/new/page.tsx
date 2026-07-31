import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import PropertyForm from "../PropertyForm";

export default async function NewPropertyPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Asked of the database rather than inferred from the role, so this screen
  // agrees with what the write will actually permit.
  const supabase = await createClient();
  const [{ data: canWrite }, { data: nodes }] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "properties.write" }),
    supabase.from("org_nodes").select("id, parent_id, level, name").order("name"),
  ]);

  if (!canWrite) {
    return (
      <div className="space-y-6">
        <PageHeader title="Add property" />
        <EmptyState
          icon={<ShieldAlert />}
          title="You cannot add properties"
          description="Managing the portfolio is granted per role. Ask an administrator if you need it."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add property"
        description="Units and their apportionment factors come next, once the property exists."
      />
      <Card>
        <CardContent className="pt-6">
          <PropertyForm nodes={nodes ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}
