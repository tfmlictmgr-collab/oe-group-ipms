import { redirect } from "next/navigation";
import { Receipt, Home } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import RentCharges, { type RentChargeRow } from "./RentCharges";

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

type Tenancy = {
  lease_id: string;
  property_name: string;
  unit_label: string;
  status: string;
  end_date: string;
  rent_outstanding: number | string;
  currency: string;
};

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

      {tenancies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tenancies.map((t) => (
            <Card key={t.lease_id}>
              <CardContent className="space-y-1 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Home className="size-4 text-muted-foreground" />
                  {t.property_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  Unit {t.unit_label} · tenancy ends{" "}
                  {new Date(t.end_date).toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "numeric",
                  })}
                </p>
                <p className="pt-1 text-lg font-semibold tabular-nums">
                  {formatMoney(t.rent_outstanding, t.currency)}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    outstanding
                  </span>
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {charges.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          title="No rent demands yet"
          description={
            tenancies.length === 0
              ? "No tenancy is recorded against your account. If that looks wrong, contact your property manager."
              : "When rent is demanded for your tenancy it will appear here, and you can pay it from this page."
          }
        />
      ) : (
        <RentCharges charges={charges} />
      )}
    </div>
  );
}
