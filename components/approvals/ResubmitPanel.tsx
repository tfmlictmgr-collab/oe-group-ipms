"use client";

import * as React from "react";
import { toast } from "sonner";
import { CornerUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { resubmitReturnedPayable } from "@/lib/approvals/actions";
import type { PayableType } from "@/lib/approvals/chain";

/**
 * The way back in, for a payable that was sent all the way back to its raiser.
 *
 * ⚠️ This exists because a return without a resubmission is a dead end wearing a
 * friendlier label than a refusal. 0170's own header recorded that an ops
 * requisition, once refused, could only be re-raised from scratch; decision 30
 * replaced that with "sent back for correction", and the correction has to be
 * able to go somewhere.
 *
 * Rendered only when the payable is actually waiting on this — the server
 * decides who may act (`resubmit_returned_payable`), and the button appearing
 * for someone who cannot is a worse outcome than it not appearing at all.
 */
export default function ResubmitPanel({
  payableType,
  payableId,
  returnedReason,
  returnedBy,
}: {
  payableType: PayableType;
  payableId: string;
  returnedReason: string | null;
  returnedBy: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");

  async function submit() {
    setBusy(true);
    const res = await resubmitReturnedPayable({ payableType, payableId, note });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message, { description: res.hint ?? undefined });
      return;
    }
    toast.success("Sent back for approval.");
    setNote("");
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
      <div className="space-y-1">
        <p className="text-sm font-medium">This was sent back to you to correct</p>
        {returnedReason && (
          <p className="text-sm text-muted-foreground">
            {returnedBy ? `${returnedBy}: ` : ""}&ldquo;{returnedReason}&rdquo;
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Nothing has been refused. Make the correction, then resend — it goes
          back to the first approval stage, and the approvals already given
          further up no longer stand, because they were given on the figures as
          they were.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`resubmit-${payableId}`}>
          What did you change?{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <textarea
          id={`resubmit-${payableId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="e.g. Corrected the generator hours to 2, per the job card."
        />
      </div>

      <Button size="sm" disabled={busy} onClick={submit}>
        <CornerUpRight className="mr-1.5 size-4" />
        {busy ? "Resending…" : "Resend for approval"}
      </Button>
    </div>
  );
}
