import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/empty-state";
import { PrintButton } from "@/components/patterns/print-button";
import { PrintMasthead } from "@/components/patterns/print-masthead";
import { roleLabel } from "@/lib/roles";
import LedgerNav from "./LedgerNav";

// The books are for finance, admin — and oversight. An FM/PM runs operations,
// not the money.
//
// ⚠️ `executive` was missing here, and three things disagreed as a result. The
// database puts an MD / Managing Partner in `oversight_roles()` (0072a), which
// grants them `ledger_entries`, `bank_accounts` and the balances views — a live
// check reads 135 entries as the POC executive. The dashboard nav lists Client
// Funds for them (`seesLedger` includes executive). And this layout answered
// "Finance access required".
//
// So an MD followed a link the product gave them to a page that told them they
// were not allowed, for data the database was already willing to hand over.
// B7 v3.3 gives the executive "All (RT)" on SC & financials; the policy said
// oversight, the menu said oversight, and only this line said no.
//
// What stays closed stays closed and is enforced below the UI: an executive
// may not execute a remittance, add a bank account, or post to the ledger.
// Those are refused in the database whoever opens this page — oversight
// authorises, finance disburses (board, 29 July 2026).
export default async function LedgerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  if (!["admin", "finance_approver", "executive"].includes(session.profile?.role ?? "")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Client Funds" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Finance access required"
          description="The client-funds ledger is restricted to finance, administrators and executives."
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

  // Printing is offered to whoever the gate above already let in — every org,
  // every role that reaches this section — and deliberately adds no check of
  // its own: it puts the reader's own screen on paper. RLS decided what is on
  // that screen, so a finance lead prints the org's position and an executive
  // prints the same page, both seeing exactly what they see now.
  const printedBy = session.profile?.full_name || session.profile?.email || undefined;
  const printedByLine = printedBy
    ? `${printedBy} · ${roleLabel(session.profile?.role, session.org?.delivery_brand)}`
    : undefined;

  return (
    <div className="printable space-y-6">
      <PrintMasthead
        org={session.org?.name ?? "Client Funds"}
        title="Client funds"
        subtitle="Money held on behalf of tenants, landlords and owners"
        by={printedByLine}
      />
      <div data-print="screen-only">
        <PageHeader
          title="Client Funds"
          description="Money held on behalf of tenants, landlords and owners — and its agreement with the bank."
          actions={<PrintButton />}
        />
      </div>
      <LedgerNav variance={latest ? Number(latest.variance) : undefined} />
      {children}
    </div>
  );
}
