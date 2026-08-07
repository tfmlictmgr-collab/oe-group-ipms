import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/patterns/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import VendorForm, { type UnlinkedUser } from "./VendorForm";

// Adding a vendor company by hand — the path that did not exist.
//
// Until now a `vendors` row could only appear through the public self-service
// application flow or a seed script. An organisation whose vendors were
// onboarded by a person rather than by self-service therefore had none at all,
// which is what left a real vendor invisible in the list, unassignable when
// dispatching, and looking at an empty My Work page.

export const dynamic = "force-dynamic";

export default async function NewVendorPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  // Mirrors the vendor list's own gate. RLS (`vendors_insert`) is the real
  // boundary; this only decides whether to show a form that would be refused.
  const role = session.profile?.role ?? "";
  if (!["admin", "facility_manager"].includes(role)) {
    redirect("/dashboard/vendors");
  }

  const supabase = await createClient();

  // Vendor-role users in this org who are attached to no company. These are
  // exactly the people the missing screen stranded, so the form offers to
  // rescue one rather than making that a separate errand nobody knows to run.
  const [{ data: vendorUsers }, { data: linked }] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name, email")
      .eq("role", "vendor")
      .is("deactivated_at", null),
    supabase.from("vendors").select("user_id").not("user_id", "is", null),
  ]);

  const taken = new Set((linked ?? []).map((v) => v.user_id as string));
  const unlinked: UnlinkedUser[] = (vendorUsers ?? [])
    .filter((u) => !taken.has(u.id))
    .map((u) => ({ id: u.id, label: u.full_name || u.email || "Vendor user" }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Add a vendor"
        description="A contractor your team can dispatch work to."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/vendors"><ArrowLeft /> Back</Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-6">
          <VendorForm unlinked={unlinked} />
        </CardContent>
      </Card>
    </div>
  );
}
