import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye } from "lucide-react";
import SettingsForm from "../SettingsForm";
import FeeSettingsForm from "./FeeSettingsForm";
import ExecutiveLimitForm from "./ExecutiveLimitForm";
import AdminOnly from "../AdminOnly";

export default async function PaymentSettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role !== "admin") return <AdminOnly what="payment gate thresholds" />;

  const supabase = await createClient();
  // The management fee is READ from `orgs` — the single source (decision 14,
  // consolidated in 0095). `payment_settings.management_fee_percent` is now a
  // mirror kept only for `create_landlord_remittance`, and reading it here
  // would show a value that is correct only until someone edits the other
  // screen.
  const [{ data: settings }, { data: org }, { data: isOperator }] = await Promise.all([
    supabase
      .from("payment_settings")
      .select("min_performance_score, approval_threshold_amount, admin_fee_percent, tier1_threshold_amount, ops_executive_requisition_limit")
      .eq("org_id", session.profile.org_id)
      .single(),
    supabase
      .from("orgs")
      .select("management_fee_pct, delivery_brand")
      .eq("id", session.profile.org_id)
      .single(),
    // The two gate controls are operator-governed as of 0149 — the same shape
    // decision 7 already uses for the permission matrix, and read-only here for
    // the same reason: an administrator who can raise the approval limit can
    // raise the limit they then approve against.
    supabase.rpc("caller_is_operator_admin"),
  ]);

  const minScore = Number(settings?.min_performance_score ?? 70);
  const threshold = Number(settings?.approval_threshold_amount ?? 1000000);
  const tier1Threshold = Number(settings?.tier1_threshold_amount ?? 100000);
  const execLimit = Number(settings?.ops_executive_requisition_limit ?? 500000);
  // 0307. The Executive is an OEA role; the limit means nothing elsewhere.
  const isOea = org?.delivery_brand === "OEA";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Payment gate</CardTitle>
          <CardDescription>
            Thresholds for the B4 vendor payment gate. Payments above the approval
            limit require an administrator or an executive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isOperator ? (
            <SettingsForm
              orgId={session.profile.org_id}
              initialMinScore={minScore}
              initialThreshold={threshold}
              initialTier1Threshold={tier1Threshold}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm">
                <Eye className="mt-0.5 size-4 flex-shrink-0 text-info" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Read-only.</span>{" "}
                  These two decide when a payment needs a second pair of hands, so
                  they are governed centrally by TENTai rather than set here —
                  an administrator who could raise the approval limit could raise
                  the limit they then approve against. Ask your TENTai contact
                  for a change.
                </p>
              </div>
              <dl className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border px-4 py-3">
                  <dt className="text-sm text-muted-foreground">Tier 1 limit</dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">
                    ₦{tier1Threshold.toLocaleString()}
                  </dd>
                </div>
                <div className="rounded-lg border px-4 py-3">
                  <dt className="text-sm text-muted-foreground">Tier 2 limit</dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">
                    ₦{threshold.toLocaleString()}
                  </dd>
                </div>
                <div className="rounded-lg border px-4 py-3">
                  <dt className="text-sm text-muted-foreground">Performance gate</dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">{minScore}</dd>
                </div>
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      {isOea && (
        <Card>
          <CardHeader>
            <CardTitle>Executive requisition limit</CardTitle>
            <CardDescription>
              The largest FM, PM or operations requisition the Executive may
              approve at the Managing Partner&apos;s stage. Never their own, and
              never a vendor payment or landlord payout.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isOperator ? (
              <ExecutiveLimitForm orgId={session.profile.org_id} initialLimit={execLimit} />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Read-only.</span>{" "}
                  Set centrally by TENTai, like the approval limits above. Ask
                  your TENTai contact for a change.
                </p>
                <dl className="max-w-xs rounded-lg border px-4 py-3">
                  <dt className="text-sm text-muted-foreground">Executive limit</dt>
                  <dd className="mt-1 text-lg font-medium tabular-nums">
                    ₦{execLimit.toLocaleString()}
                  </dd>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
            initialManagementFee={Number(org?.management_fee_pct ?? 0)}
            initialAdminFee={Number(settings?.admin_fee_percent ?? 0)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
