"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { recordStageDecision } from "@/lib/approvals/actions";
import type { PayableType, StageOrder } from "@/lib/approvals/chain";

/**
 * Approve or refuse one stage.
 *
 * The amount is deliberately absent from everything this component sends. It is
 * displayed by the parent for the person's benefit and resolved server-side for
 * the decision's — a form field carrying the amount is precisely the tier-ladder
 * attack, and there is no such field here to tamper with.
 */
export default function StageActions({
  payableType,
  payableId,
  stage,
  stageLabel,
}: {
  payableType: PayableType;
  payableId: string;
  stage: StageOrder;
  stageLabel: string;
}) {
  const [busy, setBusy] = React.useState<"approve" | "reject" | null>(null);
  const [refusing, setRefusing] = React.useState(false);
  const [reason, setReason] = React.useState("");

  async function submit(decision: "approved" | "rejected") {
    setBusy(decision === "approved" ? "approve" : "reject");
    const res = await recordStageDecision({
      payableType,
      payableId,
      stage,
      decision,
      reason: decision === "rejected" ? reason : null,
    });
    setBusy(null);

    if (!res.ok) {
      toast.error(res.message, { description: res.hint ?? undefined });
      return;
    }
    toast.success(
      decision === "approved" ? `${stageLabel} approved.` : "Payment refused."
    );
    setRefusing(false);
    setReason("");
  }

  if (refusing) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={`reason-${stage}`}>Why are you refusing this?</Label>
          <textarea
            id={`reason-${stage}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. The invoice total does not match the signed job card."
          />
          <p className="text-xs text-muted-foreground">
            They have to be able to act on this — at least 10 characters.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={busy !== null || reason.trim().length < 10}
            onClick={() => submit("rejected")}
          >
            {busy === "reject" ? "Refusing…" : "Confirm refusal"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setRefusing(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy !== null} onClick={() => submit("approved")}>
        <Check className="mr-1.5 size-4" />
        {busy === "approve" ? "Recording…" : `Approve — ${stageLabel}`}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={() => setRefusing(true)}
      >
        <X className="mr-1.5 size-4" />
        Refuse
      </Button>
    </div>
  );
}
