import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Landmark } from "lucide-react";
import RecordPaymentForm, { type ChargeOption, type AccountOption } from "./RecordPaymentForm";

// Reporting a payment made outside the portal.
//
// Open to a tenant for their OWN demands and to staff holding
// `payments.record_offline` for the buildings they manage — and the page does
// not decide which: `offline_allocatable_charges()` returns exactly what this
// caller may allocate to, with `is_own` saying which is which, and
// `submit_offline_payment_claim` vets every line again on the way in. A form
// built from a different query to the rule that vets it is decision 26's
// nav-versus-page disagreement.

export const dynamic = "force-dynamic";

export default async function RecordOfflinePaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ rent?: string; sc?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { rent, sc } = await searchParams;

  const supabase = await createClient();
  const [{ data: charges }, { data: accounts }] = await Promise.all([
    supabase.rpc("offline_allocatable_charges"),
    supabase.rpc("org_client_funds_accounts"),
  ]);

  const options = (charges ?? []) as ChargeOption[];
  const banks = (accounts ?? []) as AccountOption[];

  // Two ways to be unable to use this page, and they need different sentences —
  // "there is nothing to pay" and "we have not told you where to pay" are not
  // the same problem and do not have the same fix.
  if (banks.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Report a payment you have made" />
        <EmptyState
          icon={<Landmark className="size-6" />}
          title="No account has been published yet"
          description="This organisation has not yet set up the client-funds account that tenant payments are made into, so there is nothing to report a payment against. An administrator sets this up under Settings → Client Funds & Banking."
        />
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Report a payment you have made" />
        <EmptyState
          icon={<Landmark className="size-6" />}
          title="Nothing is outstanding"
          description="There are no unpaid rent demands or service-charge invoices to record a payment against. If you have paid something that is not showing here, speak to your property manager."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/my-rent">Back to My Rent</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard/payments/offline">
          <ArrowLeft className="size-4" />
          Back
        </Link>
      </Button>

      <PageHeader
        title="Report a payment you have made"
        description="Paid by bank transfer, or over the counter at the bank? Tell us here and attach your proof. We check it against our account before it is applied."
      />

      <RecordPaymentForm
        charges={options}
        accounts={banks}
        orgId={session.profile?.org_id ?? ""}
        preselectRent={rent ?? null}
        preselectSc={sc ?? null}
      />
    </div>
  );
}
