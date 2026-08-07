import { redirect } from "next/navigation";
import { Send } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { EmptyState } from "@/components/patterns/empty-state";
import { payoutCandidates } from "./actions";
import PayoutRun from "./PayoutRun";

export const dynamic = "force-dynamic";

export default async function PayoutsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const role = session.profile?.role ?? "";
  // An executive may LOOK at what is owed and to whom — that is oversight, and
  // B7 gives them the financial column in full. They may not SEND: the board
  // separated authorising money from moving it (29 July 2026), and both the
  // action and `enforce_payment_transition` refuse them regardless of what this
  // page renders. The button is disabled rather than hidden so the separation
  // is visible rather than mysterious.
  const canSend = ["admin", "finance_approver"].includes(role);

  const result = await payoutCandidates();

  if (!result.ok) {
    return (
      <EmptyState
        icon={<Send />}
        title="Payouts could not be loaded"
        description={result.message}
      />
    );
  }

  if (result.data.length === 0) {
    return (
      <EmptyState
        icon={<Send />}
        title="Nothing awaiting payout"
        description="A property appears here once rent has been collected from a tenant and not yet remitted to its owner. Rent that has only been demanded does not count — a landlord is paid what was received, never what was billed."
      />
    );
  }

  return <PayoutRun candidates={result.data} canSend={canSend} />;
}
