import { notFound, redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { readsPropertyFunds } from "@/lib/roles";
import AccountMovements from "../../ledger/accounts/[id]/AccountMovements";

// One of the property manager's building funds, every movement and the
// balance after each — the same view the finance ledger uses, read in the
// manager's own session, so it shows only an account on a property they hold
// (`ledger_accounts_select`'s property branch, 0249). Any other id is a 404.

export const dynamic = "force-dynamic";

export default async function PropertyFundAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  if (!readsPropertyFunds(session.profile?.role)) notFound();
  const { id } = await params;
  return <AccountMovements id={id} backHref="/dashboard/property-funds" backLabel="Client Funds" />;
}
