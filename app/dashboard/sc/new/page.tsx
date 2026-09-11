import { redirect } from "next/navigation";
import Link from "next/link";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import BudgetForm, { type PropertyOption } from "../BudgetForm";

// Creating a service-charge budget — the entry point the module never had.
//
// Gated on `sc.manage`, asked of the database rather than inferred from the
// role, so this screen agrees with what `sc_budgets_insert` will actually
// permit. An `executive` reaches the service-charge LIST (they hold
// `sc.read_all`) and is refused here, which is the intended shape: oversight
// reads the money, it does not set it.
export default async function NewBudgetPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const [{ data: canManage }, { data: properties }, { data: units }] = await Promise.all([
    supabase.rpc("has_permission", { p_capability: "sc.manage" }),
    supabase.from("properties").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("units").select("property_id"),
  ]);

  if (!canManage) {
    return (
      <div className="space-y-6">
        <PageHeader title="New budget" />
        <EmptyState
          icon={<ShieldAlert />}
          title="You cannot create budgets"
          description="Budgets and invoicing are granted per role. Ask an administrator if you need it."
        />
      </div>
    );
  }

  // Unit counts come from one query rather than a per-property fetch: the form
  // only needs them to warn that a property cannot be apportioned yet.
  const unitsByProperty = new Map<string, number>();
  for (const u of units ?? []) {
    const key = u.property_id as string;
    unitsByProperty.set(key, (unitsByProperty.get(key) ?? 0) + 1);
  }

  const options: PropertyOption[] = (properties ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    unit_count: unitsByProperty.get(p.id as string) ?? 0,
  }));

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/sc">
          <ArrowLeft /> Service charges
        </Link>
      </Button>

      <PageHeader
        title="New budget"
        description="The shared cost for a period, apportioned across a property's units."
      />

      {options.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert />}
          title="No properties yet"
          description="A budget belongs to a property. Add one to the register first."
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <BudgetForm properties={options} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
