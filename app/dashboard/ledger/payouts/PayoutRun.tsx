"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, Loader2, AlertCircle, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { runLandlordPayout, type PayoutCandidate } from "./actions";

/**
 * The landlord payout run.
 *
 * ⚠️ Deliberately one property at a time, and NOT a batch — which is the
 * opposite of the choice made for vendor approvals a screen away, so the
 * difference is worth stating. Approval is a decision that can be reconsidered;
 * a transfer cannot. `create_rent_remittance` takes a row lock per property and
 * a batch would either hold locks across several transfers or fire them
 * independently, and the failure mode of the second is "seven sent, three
 * unknown, no way to tell which from a toast". Bulk belongs where a mistake is
 * recoverable.
 */
export default function PayoutRun({
  candidates,
  canSend,
}: {
  candidates: PayoutCandidate[];
  canSend: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState(
    // The period this payout covers, as a label on the remittance. Defaults to
    // the current month because that is what a monthly run means; editable
    // because a catch-up run for an earlier period is ordinary.
    new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  );

  async function send(c: PayoutCandidate) {
    setBusy(c.propertyId);
    try {
      const r = await runAction(
        runLandlordPayout({
          propertyId: c.propertyId,
          landlordUserId: c.landlordUserId,
          period,
        })
      );
      if (r.status === "sent") {
        toast.success(`Sent to ${c.landlordName}.`, {
          description: `Reference ${r.reference}.`,
        });
      } else {
        // A pending transfer is not a success and must not read like one. The
        // webhook settles it; claiming it landed would invite a re-send.
        toast.message("The transfer is pending at the gateway.", {
          description: `Reference ${r.reference}. It will settle on its own — do not send again.`,
          duration: Infinity,
          closeButton: true,
        });
      }
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That payout could not be sent."), {
        description: hintOf(e),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  const total = candidates.reduce((a, c) => a + c.collected, 0);
  const payable = candidates.filter((c) => c.hasRecipient);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-4 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Held for landlords
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatNaira(total)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Collected from tenants, net of fees, not yet paid out.
          </p>
        </Card>
        <Card className="p-4 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Ready to send
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {payable.length} of {candidates.length}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {candidates.length - payable.length > 0
              ? `${candidates.length - payable.length} landlord(s) have no verified bank recipient.`
              : "Every landlord has a verified bank recipient."}
          </p>
        </Card>
      </div>

      <div className="max-w-xs space-y-1.5">
        <Label htmlFor="period">Period this run covers</Label>
        <Input
          id="period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          placeholder="e.g. August 2026"
        />
      </div>

      <ul className="space-y-2.5">
        {candidates.map((c) => (
          <li key={c.propertyId}>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 font-medium">
                    <Home className="size-4 text-muted-foreground" />
                    {c.propertyName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.landlordName} · {c.charges} collected demand
                    {c.charges === 1 ? "" : "s"}
                  </p>
                  {!c.hasRecipient && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertCircle className="mt-0.5 size-3.5 flex-shrink-0" />
                      No verified bank recipient on file — add their bank
                      details before this can be sent.
                    </p>
                  )}
                </div>

                <div className="flex flex-shrink-0 items-center gap-3">
                  <p className="text-right text-lg font-semibold tabular-nums">
                    {formatNaira(c.collected)}
                  </p>
                  <Button
                    variant="brand"
                    disabled={!canSend || !c.hasRecipient || busy !== null || !period.trim()}
                    onClick={() => send(c)}
                    title={
                      !canSend
                        ? "Oversight authorises; finance disburses."
                        : undefined
                    }
                  >
                    {busy === c.propertyId ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Send />
                    )}
                    {busy === c.propertyId ? "Sending…" : "Send payout"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
