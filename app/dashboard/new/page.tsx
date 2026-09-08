import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import NewRequestForm from "./NewRequestForm";

/**
 * What a link into this form is allowed to say on the tenant's behalf.
 *
 * ⚠️ A closed set, matched exactly — never free text lifted out of the URL.
 * This form's whole output is a `tickets` row raised in the caller's own name,
 * so a `?message=` parameter would let one person hand another a link that
 * files a request saying whatever they wrote. The link chooses WHICH sentence,
 * the server owns WHAT it says, and the person can edit it before sending —
 * it lands in the textarea, not in the database.
 */
const OPENERS: Record<string, (where: string, ends: string) => string> = {
  renewal: (where, ends) =>
    `I would like to renew my tenancy of ${where}, which ends on ${ends}. ` +
    `Please let me know the terms for the next period.`,
  not_renewing: (where, ends) =>
    `I will not be renewing my tenancy of ${where}, which ends on ${ends}. ` +
    `Please let me know what I need to do before the end of the term.`,
};

export default async function NewRequestPage({
  searchParams,
}: {
  // Set by the renewal notice's destination (the tenancy page), which is where
  // a tenant is sent when they are told their term is ending. Nothing here is
  // trusted as data: `lease` only ever PRE-SELECTS an option this page fetched
  // under the caller's own RLS, and `raiseRequest` re-resolves the tenancy from
  // the caller's own live leases regardless of what the browser sends (0273).
  searchParams?: Promise<{ lease?: string; about?: string }>;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const sp = (await searchParams) ?? {};

  // A tenant's home is their own tracker, not the operational requests list —
  // which the nav does not offer them, so "Back" used to lead somewhere they
  // had no route to.
  const isTenant = session.profile?.role === "tenant";
  const back = isTenant ? "/dashboard/my-requests" : "/dashboard";

  // ── Only ever a LIST TO PICK FROM (0273) ────────────────────────────────
  //
  // The org and the occupied property are still resolved server-side inside
  // `raiseRequest`, from the caller's own session — never trusted from what
  // the browser sends. What is fetched here is only the CANDIDATE list a
  // picker can offer, and it is fetched under the caller's own RLS, so it can
  // only ever contain what `raiseRequest` would independently re-verify
  // anyway: a tenant's own live tenancies, or a landlord/staff member's own
  // reachable properties.
  const supabase = await createClient();
  let tenancyOptions: { id: string; label: string }[] = [];
  let propertyOptions: { id: string; label: string; propertyId?: string }[] = [];
  let unitOptions: { id: string; label: string; propertyId?: string }[] = [];
  let prefill = "";
  let prefillCategory = "";
  let prefillLeaseId = "";

  if (isTenant) {
    const { data } = await supabase.rpc("my_tenancies");
    const live = ((data ?? []) as {
      lease_id: string; property_name: string | null; unit_label: string | null;
      status: string; end_date: string | null;
    }[]).filter((t) => t.status === "active" || t.status === "renewed");

    tenancyOptions = live.map((t) => ({
      id: t.lease_id,
      label: `${t.unit_label ?? "Your unit"}, ${t.property_name ?? "—"}`,
    }));

    // ── The renewal opener, composed from the tenancy's OWN row ───────────
    //
    // Composed here, from what `my_tenancies()` returned for this caller, so
    // the sentence names a real tenancy of theirs and a real date — not the
    // ones a URL claimed. An `about` naming no known opener, or a `lease` this
    // tenant does not hold, simply produces nothing and the form opens empty.
    const opener = sp.about ? OPENERS[sp.about] : undefined;
    const subject = live.find((t) => t.lease_id === sp.lease) ?? (live.length === 1 ? live[0] : undefined);
    if (opener && subject) {
      prefill = opener(
        `${subject.unit_label ?? "my unit"}, ${subject.property_name ?? "the property"}`,
        subject.end_date
          ? new Date(subject.end_date).toLocaleDateString("en-GB", {
              timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric",
            })
          : "the end of the term"
      );
      prefillCategory = "general";
      prefillLeaseId = subject.lease_id;
    }

    // Only offered when there is a real choice to make — one tenancy resolves
    // itself silently, the common case, exactly as this page has always
    // behaved.
    if (tenancyOptions.length <= 1) tenancyOptions = [];
  } else {
    const [{ data: props }, { data: units }] = await Promise.all([
      supabase.from("properties").select("id, name").order("name"),
      supabase.from("units").select("id, label, property_id").order("label"),
    ]);
    propertyOptions = (props ?? []).map((p) => ({ id: p.id, label: p.name }));
    unitOptions = (units ?? []).map((u) => ({
      id: u.id, label: u.label, propertyId: u.property_id as string,
    }));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="New Service Request"
        description={
          prefill
            ? "We have started this off for you — change anything you like before sending it. It goes to the letting team with your tenancy attached."
            : "Describe the issue. We classify it, log it, and tell the team straight away."
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={back}>
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <NewRequestForm
        tenancyOptions={tenancyOptions}
        propertyOptions={propertyOptions}
        unitOptions={unitOptions}
        initialMessage={prefill}
        initialCategory={prefillCategory}
        initialLeaseId={tenancyOptions.length > 0 ? prefillLeaseId : ""}
      />
    </div>
  );
}
