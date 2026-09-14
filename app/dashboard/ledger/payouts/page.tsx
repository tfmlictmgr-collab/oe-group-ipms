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
import BankTransferAccount from "@/components/payouts/BankTransferAccount";
import RecordBankTransfer from "@/components/payouts/RecordBankTransfer";
import { getChainState, formatNaira } from "@/lib/approvals/chain";
import { payoutAccountFor, openPayoutRequestFor, orgGatewayUsable } from "@/lib/payout-views";
import { payoutCandidates, raisedPayouts } from "./actions";
import PayoutRun from "./PayoutRun";
import ReleasePayout from "./ReleasePayout";

export const dynamic = "force-dynamic";

export default async function PayoutsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const role = session.profile?.role ?? "";
  const orgId = session.profile?.org_id ?? "";
  // Finance raises and releases, and only finance (decision 16). An executive
  // may LOOK at what is owed and to whom — that is oversight, and B7 gives them
  // the financial column in full — and an administrator may set up where a
  // landlord is paid. Neither is shown a button the database is certain to
  // refuse: that reads as a broken system rather than a deliberate boundary.
  const isFinance = role === "finance_approver";
  const managesAccounts = ["admin", "finance_approver"].includes(role);

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

  // How each landlord can be paid (0289): through Paystack, by bank transfer,
  // or not yet at all — and if not yet, how to ask them.
  const landlordIds = Array.from(new Set([
    ...rows.map((r) => r.landlordUserId).filter((x): x is string => Boolean(x)),
    ...result.data.map((c) => c.landlordUserId),
  ]));
  const [gatewayUsable, gatewayRows, contactRows, views] = await Promise.all([
    orgGatewayUsable(orgId),
    landlordIds.length
      ? supabase
          .from("payout_recipients")
          .select("user_id")
          .eq("party", "landlord")
          .eq("active", true)
          .neq("gateway", "manual")
          .not("recipient_code", "is", null)
          .in("user_id", landlordIds)
      : Promise.resolve({ data: [] as { user_id: string }[] }),
    landlordIds.length
      ? supabase.from("users").select("id, email, phone").in("id", landlordIds)
      : Promise.resolve({ data: [] as { id: string; email: string | null; phone: string | null }[] }),
    managesAccounts
      ? Promise.all(
          landlordIds.map(async (uid) => ({
            uid,
            account: await payoutAccountFor(orgId, { party: "landlord", userId: uid }),
            request: await openPayoutRequestFor(orgId, { userId: uid }),
          }))
        )
      : Promise.resolve([]),
  ]);
  const hasGateway = new Set((gatewayRows.data ?? []).map((r) => r.user_id));
  const contact = new Map((contactRows.data ?? []).map((u) => [u.id, u]));
  const view = new Map(views.map((v) => [v.uid, v]));

  /** Paystack will take it, or a confirmed bank-transfer account exists. */
  const payable = (uid: string | null) =>
    Boolean(uid && ((gatewayUsable && hasGateway.has(uid)) || view.get(uid)?.account?.verified));

  const setupFor = (uid: string, name: string) =>
    managesAccounts ? (
      <BankTransferAccount
        party="landlord"
        userId={uid}
        payeeName={name}
        purpose="rent we have collected for you, net of our fees"
        defaultEmail={contact.get(uid)?.email ?? null}
        defaultPhone={contact.get(uid)?.phone ?? null}
        account={view.get(uid)?.account ?? null}
        request={view.get(uid)?.request ?? null}
        canManage={managesAccounts}
        path="/dashboard/ledger/payouts"
      />
    ) : null;

  return (
    <div className="space-y-6">
      {withChain.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Raised, awaiting release</CardTitle>
            <CardDescription>
              The collected rent for these is already claimed and held. Each one
              goes out once job sign-off, the audit check and final approval are
              recorded against it — through Paystack, or by a bank transfer the
              payment officer makes and records.
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
                    isFinance ? (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {gatewayUsable && r.landlordUserId && hasGateway.has(r.landlordUserId) && (
                          <ReleasePayout remittanceId={r.remittanceId} landlordName={r.landlordName} />
                        )}
                        <RecordBankTransfer
                          payableType="landlord_payout"
                          payableId={r.remittanceId}
                          orgId={orgId}
                          payeeName={r.landlordName}
                          path="/dashboard/ledger/payouts"
                        />
                      </div>
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
                {r.landlordUserId && !payable(r.landlordUserId) && managesAccounts && (
                  <div className="border-t border-border pt-3">
                    {setupFor(r.landlordUserId, r.landlordName)}
                  </div>
                )}
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
        <PayoutRun
          candidates={result.data}
          canSend={isFinance}
          setup={Object.fromEntries(
            result.data
              .filter((c) => !c.hasRecipient)
              .map((c) => [c.landlordUserId, setupFor(c.landlordUserId, c.landlordName)])
          )}
        />
      )}
    </div>
  );
}
