import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import SubmitInvoiceForm from "./SubmitInvoiceForm";
import RoleGate, { roleAllowed } from "../../RoleGate";
import { FM_PM } from "@/lib/roles";

export default async function NewPaymentPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // ⚠️ Gated to match `payments_insert` exactly. The page was open to anyone
  // signed in, so an auditor, a payment approver, the payment officer, a tenant
  // or a vendor could pick a contractor, attach an invoice, press Submit and be
  // told "Could not submit invoice" by a 403 — a whole form that could never
  // succeed. The policy is the authority; this is the same list, so the form is
  // offered only to people it will accept.
  if (!roleAllowed(session.profile?.role, ["admin", ...FM_PM, "regional_manager"])) {
    return <RoleGate title="Submit Vendor Invoice" />;
  }

  const supabase = await createClient();

  // Vendors, and the finished jobs each one could be invoicing for.
  //
  // Fetched together rather than on demand because the list is small and the
  // picker has to narrow to the chosen vendor the moment it changes — a
  // round trip per selection would make the form feel broken. The one-live-
  // invoice rule is NOT applied here: `payments_work_order_valid` (0128)
  // enforces it at the table, and a picker that silently hides an already-
  // invoiced job leaves the user wondering where it went. Better to offer it
  // and have the database say why not.
  const [{ data: vendors }, { data: jobs }] = await Promise.all([
    supabase.from("vendors").select("id, name").order("name"),
    supabase
      .from("tickets")
      .select("id, summary, assigned_vendor_id, status")
      .not("assigned_vendor_id", "is", null)
      .in("status", ["resolved", "closed"])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

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
        jobs={
          (jobs as {
            id: string;
            summary: string | null;
            assigned_vendor_id: string;
          }[]) ?? []
        }
      />
    </div>
  );
}
