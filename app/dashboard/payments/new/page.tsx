import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
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
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-xl font-semibold text-neutral-800">
        Submit Vendor Invoice
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        Creates a payment request that enters the B4 gate at service
        verification.
      </p>
      <SubmitInvoiceForm
        orgId={session.profile!.org_id}
        vendors={(vendors as { id: string; name: string }[]) ?? []}
      />
    </div>
  );
}
