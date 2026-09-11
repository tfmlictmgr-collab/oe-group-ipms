import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatNaira } from "@/lib/currency";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import LeaseForm, { type OfferPrefill } from "./LeaseForm";
import { endDateFor } from "@/lib/tenancy-offer";

export default async function NewLeasePage({
  searchParams,
}: {
  searchParams: Promise<{ offer?: string }>;
}) {
  const { offer: offerId } = await searchParams;
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

  // ── The accepted offer this tenancy is being recorded from (0263) ────────
  //
  // Read through the CALLER's session, so RLS decides: `tenancy_offers_select`
  // delegates to `tenant_applications`, and a manager who cannot see the
  // application cannot pull its terms out through this query string either.
  //
  // Only an ACCEPTED offer prefills anything. An offer still awaiting an answer
  // is not something to record a tenancy from — that is the sequence this whole
  // change exists to put the right way round.
  let prefill: OfferPrefill | null = null;
  if (offerId) {
    const { data: offerRow } = await supabase
      .from("tenancy_offers")
      .select(
        "id, status, property_id, unit_id, rent_amount, deposit_amount, service_charge_amount, " +
        "term_months, commences_on, " +
        "tenant_applications(applicant_name, applicant_email), " +
        "properties(name), units(label)"
      )
      .eq("id", offerId)
      .eq("status", "accepted")
      .maybeSingle();

    // Cast once. PostgREST's inferred type for an embedded select on a table
    // the generated types do not yet carry is a union with `GenericStringError`,
    // which makes every field access an error — the same `as unknown as` shape
    // the rest of this codebase uses for embeds.
    const o = offerRow as unknown as {
      id: string;
      property_id: string;
      unit_id: string;
      rent_amount: string | number;
      deposit_amount: string | number;
      service_charge_amount: string | number;
      term_months: number;
      commences_on: string;
      tenant_applications: { applicant_name: string; applicant_email: string } | null;
      properties: { name: string } | null;
      units: { label: string } | null;
    } | null;

    if (o) {
      const app = o.tenant_applications;
      const unit = o.units;
      const property = o.properties;

      // The tenant's own account, IF they have redeemed their invitation yet.
      // Matched on the application's email, which is the address the invitation
      // was issued to — the same string, not a guess.
      const { data: tenant } = app?.applicant_email
        ? await supabase
            .from("users")
            .select("id")
            .eq("email", app.applicant_email)
            .eq("role", "tenant")
            .maybeSingle()
        : { data: null };

      prefill = {
        offerId: o.id,
        propertyId: o.property_id,
        propertyName: property?.name ?? null,
        unitId: o.unit_id,
        unitLabel: unit?.label ?? "the offered unit",
        applicantName: app?.applicant_name ?? "the applicant",
        tenantUserId: (tenant as { id: string } | null)?.id ?? null,
        startDate: o.commences_on,
        endDate: endDateFor(o.commences_on, Number(o.term_months)),
        rentAmount: String(o.rent_amount ?? ""),
        depositAmount: String(o.deposit_amount ?? ""),
        serviceCharge: String(o.service_charge_amount ?? ""),
      };
    }
  }

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
        description={
          prefill
            ? `Prefilled from the offer ${prefill.applicantName} accepted. Check it against what was agreed before saving.`
            : "It starts as a draft. Activating it occupies the unit and lets rent be billed against it."
        }
      />

      {prefill && Number(prefill.serviceCharge) > 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {/* ⚠️ Rent and service charge are never one figure (decision 25),
                and a lease holds only the rent. The service charge is billed
                from the property's own budget, so it is stated here rather than
                silently folded into the rent above. */}
            The offer also carried a service charge of{" "}
            <span className="font-medium text-foreground">
              {formatNaira(Number(prefill.serviceCharge))}
            </span>{" "}
            per annum. That is not part of the rent and is not recorded on a
            tenancy — it is billed from the property&rsquo;s service-charge
            budget, which is where it has to be raised.
          </CardContent>
        </Card>
      )}

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
            prefill={prefill}
          />
        </CardContent>
      </Card>
    </div>
  );
}
