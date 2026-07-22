import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import NewRequestForm from "./NewRequestForm";

export default async function NewRequestPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Auto-link a resident's request to the property of the unit they occupy, so
  // the Facility Manager who manages that property sees it (property-scoped RLS).
  const supabase = await createClient();
  const { data: unit } = await supabase
    .from("units")
    .select("property_id")
    .eq("occupant_user_id", session.user.id)
    .limit(1)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-xl font-semibold text-neutral-800">
        New Service Request
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        Describe the issue. Our team is notified as soon as you submit.
      </p>
      <NewRequestForm
        orgId={session.profile!.org_id}
        propertyId={unit?.property_id ?? null}
      />
    </div>
  );
}
