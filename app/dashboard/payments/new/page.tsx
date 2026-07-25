import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import SubmitInvoiceForm from "./SubmitInvoiceForm";

export default async function NewPaymentPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: vendors } = await supabase
    .from("vendors")
    .select("id, name")
    .order("name");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Submit Vendor Invoice"
        description="Creates a payment request that enters the B4 gate at service verification."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/payments">
              <ArrowLeft /> Back
            </Link>
          </Button>
        }
      />
      <SubmitInvoiceForm
        orgId={session.profile!.org_id}
        vendors={(vendors as { id: string; name: string }[]) ?? []}
      />
    </div>
  );
}
