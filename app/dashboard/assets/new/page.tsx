import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import RoleGate, { roleAllowed } from "../../RoleGate";
import { writableProperties } from "../actions";
import AssetForm from "./AssetForm";

export default async function NewAssetPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!roleAllowed(session.profile?.role, ["admin", "facility_manager"])) {
    return <RoleGate title="Add asset" />;
  }

  const supabase = await createClient();
  // All RLS-scoped: the pickers can only offer what the caller may actually use.
  const [props, units, vendors, users, defs, existing] = await Promise.all([
    // Only properties this user may actually create assets on.
    writableProperties(),
    supabase.from("units").select("id, label, property_id").order("label"),
    supabase.from("vendors").select("id, name").order("name"),
    supabase.from("users").select("id, full_name, email").order("full_name"),
    supabase
      .from("asset_field_definitions")
      .select("field_key, label, field_type, options, help_text, required")
      .eq("active", true)
      .order("sort_order"),
    // Existing assets, for the "Part of" assembly picker (0121). RLS-scoped
    // like everything else here, and filtered to the chosen property in the
    // form itself — the trigger refuses a cross-property parent anyway.
    supabase
      .from("assets")
      .select("id, name, asset_tag, property_id")
      .is("deleted_at", null)
      .order("name"),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Add asset"
        description="Only property, tag and name are required — everything else can be filled in later."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/assets">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <AssetForm
        properties={props.map((p) => ({ id: p.id, label: p.name }))}
        units={(units.data ?? [])
          .filter((u) => props.some((p) => p.id === u.property_id))
          .map((u) => ({ id: u.id, label: u.label, propertyId: u.property_id }))}
        vendors={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.name }))}
        users={(users.data ?? []).map((u) => ({
          id: u.id, label: u.full_name ?? u.email ?? "User",
        }))}
        customDefs={defs.data ?? []}
        assets={(existing.data ?? []).map((a) => ({
          id: a.id,
          label: a.asset_tag ? `${a.name} (${a.asset_tag})` : a.name,
          propertyId: a.property_id as string,
        }))}
      />
    </div>
  );
}
