import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import LedgerNav from "./LedgerNav";

// Money is finance + admin only. An FM/PM runs operations, not the books.
export default async function LedgerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  if (!["admin", "finance_approver"].includes(session.profile?.role ?? "")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Client Funds" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Finance access required"
          description="The client-funds ledger is restricted to finance and administrators."
        />
      </div>
    );
  }

  // Most recent reconciliation, so an outstanding variance is visible from any
  // tab rather than only on the page that computes it.
  const supabase = await createClient();
  const { data: latest } = await supabase
    .from("reconciliations")
    .select("variance")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client Funds"
        description="Money held on behalf of tenants, landlords and owners — and its agreement with the bank."
      />
      <LedgerNav variance={latest ? Number(latest.variance) : undefined} />
      {children}
    </div>
  );
}
