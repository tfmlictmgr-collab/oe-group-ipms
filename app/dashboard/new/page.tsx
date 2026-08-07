import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
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
      {/* The org and the occupied property are resolved server-side in
          `raiseRequest`, from the session rather than from props the browser
          could edit. */}
      <NewRequestForm />
    </div>
  );
}
