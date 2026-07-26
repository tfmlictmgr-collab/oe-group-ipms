import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import SettingsForm from "../SettingsForm";
import FeeSettingsForm from "./FeeSettingsForm";
import AdminOnly from "../AdminOnly";

export default async function PaymentSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="payment gate thresholds" />;

  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("payment_settings")
    .select(
      "min_performance_score, approval_threshold_amount, management_fee_percent, admin_fee_percent"
    )
    .eq("org_id", session.profile.org_id)
    .single();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Payment gate</CardTitle>
          <CardDescription>
            Admin-configurable thresholds for the B4 vendor payment gate. Payments
            above the approval limit require an administrator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            orgId={session.profile.org_id}
            initialMinScore={Number(settings?.min_performance_score ?? 70)}
            initialThreshold={Number(settings?.approval_threshold_amount ?? 1000000)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fees deducted before remittance</CardTitle>
          <CardDescription>
            What the organisation retains from rent collected before the balance is
            remitted to the landlord. Both default to zero, so nothing is ever
            deducted until you set them deliberately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FeeSettingsForm
            orgId={session.profile.org_id}
            initialManagementFee={Number(settings?.management_fee_percent ?? 0)}
            initialAdminFee={Number(settings?.admin_fee_percent ?? 0)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
