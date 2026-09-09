import { redirect } from "next/navigation";
import { Receipt } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { type RentChargeRow } from "./RentCharges";
import RentBoard, { type Tenancy } from "./RentBoard";
import { MyOfflinePayments } from "@/components/patterns/my-offline-payments";

// What the person who owes the rent actually sees.
//
// Day 9 built the whole accounting side of rent — demands raised on schedule,
// the fee split, the landlord's share reaching the segregated ledger — and no
// way for a tenant to see any of it or pay. `my_tenancies()` was written for
// this view and was called nowhere in the app (found by PC2, 2026-08-06).
//
// Read through `my_rent_charges()` / `my_tenancies()`, both SECURITY DEFINER on
// `auth.uid()`: a tenant has no read on `properties` or `units`, so the flat's
// name comes back denormalised rather than by granting access to the register
// it lives in — the same shape `my_requests()` already uses for tickets.

export const dynamic = "force-dynamic";

export default async function MyRentPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (session.profile?.role === "viewer") redirect("/dashboard/overview");

  const supabase = await createClient();
  const [{ data: tenancyRows }, { data: chargeRows }] = await Promise.all([
    supabase.rpc("my_tenancies"),
    supabase.rpc("my_rent_charges"),
  ]);

  const tenancies = (tenancyRows ?? []) as Tenancy[];
  const charges = (chargeRows ?? []) as RentChargeRow[];

  const currency = charges[0]?.currency ?? tenancies[0]?.currency ?? "NGN";
  const outstanding = charges.reduce((a, c) => a + Number(c.outstanding), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Rent"
        description={
          charges.length === 0
            ? "Rent demands for your tenancy will appear here."
            : outstanding > 0
              ? `${formatMoney(outstanding, currency)} outstanding across ${charges.length} demand${charges.length === 1 ? "" : "s"}.`
              : "You are up to date — nothing outstanding."
        }
      />

      {charges.length === 0 && tenancies.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          title="No rent demands yet"
          description="No tenancy is recorded against your account. If that looks wrong, contact your property manager."
        />
      ) : (
        // The tenancy cards, the Outstanding/Paid tabs and the demands are one
        // component because they are one interaction: picking a home decides
        // which demands are listed, and that has to happen without a round trip.
        <RentBoard tenancies={tenancies} charges={charges} />
      )}

      {/* Paying by transfer or at the bank is the ordinary way rent is settled
          in this market, and until 0281 the product had no route for it at all —
          a tenant who had paid went on being shown the arrears. Shown with
          `showEmpty` so the route is discoverable BEFORE somebody has used it;
          a feature you can only find once you have already used it is not a
          feature a first-time payer has. */}
      <MyOfflinePayments showEmpty={charges.length > 0} />
    </div>
  );
}
