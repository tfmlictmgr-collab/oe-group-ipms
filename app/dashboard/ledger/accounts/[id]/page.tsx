import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import AccountMovements from "./AccountMovements";

// One account, every posting, and its balance after each (0318). The view is
// shared with the property manager's Client Funds (`AccountMovements`).

export const dynamic = "force-dynamic";

export default async function AccountLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  const { id } = await params;
  return <AccountMovements id={id} backHref="/dashboard/ledger" backLabel="Balances" />;
}
