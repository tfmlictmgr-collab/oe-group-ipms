import { redirect } from "next/navigation";
import { Send } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import ChainTrail from "@/components/approvals/ChainTrail";
import { getChainState, formatNaira } from "@/lib/approvals/chain";
import { payoutCandidates, raisedPayouts } from "./actions";
import PayoutRun from "./PayoutRun";
import ReleasePayout from "./ReleasePayout";

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

  const [result, raised] = await Promise.all([payoutCandidates(), raisedPayouts()]);

  if (!result.ok) {
    return (
      <EmptyState
        icon={<Send />}
        title="Payouts could not be loaded"
        description={result.message}
      />
    );
  }

  // ⚠️ Raised payouts are read and rendered SEPARATELY from candidates, and the
  // page no longer returns early when there are no candidates. Raising a payout
  // claims the collected rent, so the property leaves the candidate list the
  // moment it is raised — an early return on an empty candidate list therefore
  // showed "Nothing awaiting payout" over money that had been claimed and was
  // waiting to be released, and there was no other screen it appeared on.
  const rows = raised.ok ? raised.data : [];
  const supabase = await createClient();
  const withChain = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      state: await getChainState(supabase, "landlord_payout", r.remittanceId),
    }))
  );

  return (
    <div className="space-y-6">
      {withChain.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Raised, awaiting release</CardTitle>
            <CardDescription>
              The collected rent for these is already claimed and held. Each one
              goes out once job sign-off, the audit check and final approval are
              recorded against it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {withChain.map((r) => (
              <div key={r.remittanceId} className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {r.propertyName} — {formatNaira(r.netAmount)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      To {r.landlordName}
                      {r.period ? ` · ${r.period}` : ""} · {r.reference}
                    </p>
                  </div>
                  {r.state.clearedForDisbursement ? (
                    canSend ? (
                      <ReleasePayout
                        remittanceId={r.remittanceId}
                        landlordName={r.landlordName}
                      />
                    ) : (
                      <Badge variant="muted">Finance releases this</Badge>
                    )
                  ) : (
                    <Badge variant={r.state.rejected ? "destructive" : "warning"}>
                      {r.state.rejected ? "Refused" : "Awaiting approval"}
                    </Badge>
                  )}
                </div>
                <ChainTrail state={r.state} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {result.data.length === 0 ? (
        withChain.length === 0 ? (
          <EmptyState
            icon={<Send />}
            title="Nothing awaiting payout"
            description="A property appears here once rent has been collected from a tenant and not yet remitted to its owner. Rent that has only been demanded does not count — a landlord is paid what was received, never what was billed."
          />
        ) : null
      ) : (
        <PayoutRun candidates={result.data} canSend={canSend} />
      )}
    </div>
  );
}
