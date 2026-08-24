import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/patterns/empty-state";
import { FileText, ShieldAlert } from "lucide-react";
import LettingsForm, { type Landlord } from "./LettingsForm";

export default async function LettingsSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const profile = session.profile!;

  const supabase = await createClient();
  const [orgRes, moduleRes, landlordsRes, termsRes] = await Promise.all([
    supabase
      .from("orgs")
      .select("management_fee_pct, admin_fee_flat, admin_fee_basis, renewal_notice_days, rent_demand_lead_days")
      .eq("id", profile.org_id)
      .single(),
    supabase.rpc("org_has_module", { p_org_id: profile.org_id, p_module: "lettings" }),
    supabase.from("users").select("id, full_name, email")
      .eq("role", "property_owner").is("deactivated_at", null).order("full_name"),
    supabase.from("landlord_terms").select("landlord_user_id, management_fee_pct"),
  ]);

  if (!moduleRes.data) {
    return (
      <EmptyState
        icon={<FileText />}
        title="Lettings is not enabled here"
        description="Rent, fees and renewal notices belong to the property side of the group."
      />
    );
  }

  if (profile.role !== "admin") {
    return (
      <EmptyState
        icon={<ShieldAlert />}
        title="Administrators only"
        description="These settings decide what every landlord is paid and when tenants are told their tenancy is ending."
      />
    );
  }

  const rateByLandlord = new Map(
    (termsRes.data ?? []).map((t) => [t.landlord_user_id, t.management_fee_pct])
  );
  const landlords: Landlord[] = (landlordsRes.data ?? []).map((l) => ({
    id: l.id,
    name: l.full_name ?? l.email ?? "Unnamed",
    negotiatedPct:
      rateByLandlord.get(l.id) === null || rateByLandlord.get(l.id) === undefined
        ? null
        : Number(rateByLandlord.get(l.id)),
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Lettings</CardTitle>
        <CardDescription>
          What the organisation charges to manage a property, and when tenants
          hear from you about rent and renewal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <LettingsForm
          managementFeePct={Number(orgRes.data?.management_fee_pct ?? 0)}
          adminFeeFlat={Number(orgRes.data?.admin_fee_flat ?? 0)}
          adminFeeBasis={(orgRes.data?.admin_fee_basis ?? "per_tenancy") as "per_tenancy" | "per_demand"}
          renewalNoticeDays={(orgRes.data?.renewal_notice_days ?? [90, 60, 30]) as number[]}
          rentDemandLeadDays={Number(orgRes.data?.rent_demand_lead_days ?? 30)}
          landlords={landlords}
        />
      </CardContent>
    </Card>
  );
}
