import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import LeaseForm from "./LeaseForm";

export default async function NewLeasePage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();
  const [canWriteRes, propsRes, tenantsRes, moduleRes] = await Promise.all([
    // Asked of the database rather than inferred from the role, so this screen
    // agrees with what the write will actually permit.
    supabase.rpc("has_permission", { p_capability: "leases.write" }),
    // RLS decides which properties come back, so an FM/PM is offered only the
    // ones they hold.
    supabase.from("properties").select("id, name").is("deleted_at", null).order("name"),
    supabase.from("users").select("id, full_name, email")
      .eq("role", "tenant").is("deactivated_at", null).order("full_name"),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
  ]);

  // For the inline "add a unit" the form offers when a property has none
  // (decision 31). The SAME list the property form uses, deliberately: decision
  // 20's lesson is that a free-text unit type produces "Shop", "shop" and
  // "Shop Space" as three different things nothing can count.
  const { data: unitTypes } = await supabase
    .from("unit_types")
    .select("id, label, category")
    .order("label");

  if (!moduleRes.data || !canWriteRes.data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Record a tenancy" />
        <EmptyState
          icon={<ShieldAlert />}
          title={moduleRes.data ? "You cannot record tenancies" : "Lettings is not enabled here"}
          description={
            moduleRes.data
              ? "Creating a lease sets what a tenant owes and what a landlord is paid. Ask an administrator if you need it."
              : "Tenancies and rent belong to the property side of the group."
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/dashboard/leases"><ArrowLeft className="size-4" /> Rent roll</Link>
      </Button>

      <PageHeader
        title="Record a tenancy"
        description="It starts as a draft. Activating it occupies the unit and lets rent be billed against it."
      />

      <Card>
        <CardContent className="pt-6">
          <LeaseForm
            properties={(propsRes.data ?? []).map((p) => ({ id: p.id, label: p.name }))}
            tenants={(tenantsRes.data ?? []).map((t) => ({
              id: t.id,
              label: t.full_name ?? t.email ?? "Unnamed",
            }))}
            unitTypes={(unitTypes ?? []).map((t) => ({
              id: t.id,
              label: t.label,
              category: t.category as "residential" | "commercial",
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
