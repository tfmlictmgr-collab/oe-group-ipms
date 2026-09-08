import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import NewRequestForm from "./NewRequestForm";

export default async function NewRequestPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

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

  if (isTenant) {
    const { data } = await supabase.rpc("my_tenancies");
    tenancyOptions = ((data ?? []) as {
      lease_id: string; property_name: string | null; unit_label: string | null; status: string;
    }[])
      .filter((t) => t.status === "active" || t.status === "renewed")
      .map((t) => ({
        id: t.lease_id,
        label: `${t.unit_label ?? "Your unit"}, ${t.property_name ?? "—"}`,
      }));
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
        description="Describe the issue. We classify it, log it, and tell the team straight away."
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
      />
    </div>
  );
}
