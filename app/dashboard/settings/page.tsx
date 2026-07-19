import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import SettingsForm from "./SettingsForm";

export default async function SettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Admin-only page (B7: admin configures approver limits/thresholds).
  if (session.profile?.role !== "admin") {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold text-neutral-800">Settings</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Only administrators can configure payment gate thresholds.
        </p>
      </div>
    );
  }

  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("payment_settings")
    .select("min_performance_score, approval_threshold_amount")
    .eq("org_id", session.profile.org_id)
    .single();

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-xl font-semibold text-neutral-800">
        Payment Gate Settings
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        Admin-configurable thresholds for the B4 vendor payment gate.
      </p>
      <SettingsForm
        orgId={session.profile.org_id}
        initialMinScore={Number(settings?.min_performance_score ?? 70)}
        initialThreshold={Number(settings?.approval_threshold_amount ?? 1000000)}
      />
    </div>
  );
}
