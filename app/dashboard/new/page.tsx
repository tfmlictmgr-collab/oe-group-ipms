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
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="New Service Request"
        description="Describe the issue. Our team is notified as soon as you submit."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <NewRequestForm
        orgId={session.profile!.org_id}
        propertyId={unit?.property_id ?? null}
      />
    </div>
  );
}
