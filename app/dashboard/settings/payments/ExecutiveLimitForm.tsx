"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateOpsExecutiveLimit } from "../actions";
import { runAction, describeError } from "@/lib/run-action";

/**
 * The OEA Executive's requisition limit (0307) — the largest FM/PM/Ops
 * requisition they may approve at the Managing Partner's stage. Operator-only,
 * like the tier limits, and for the same reason: whoever sets it decides how
 * much leaves without the Managing Partner's signature.
 */
export default function ExecutiveLimitForm({
  orgId,
  initialLimit,
}: {
  orgId: string;
  initialLimit: number;
}) {
  const [limit, setLimit] = useState(String(initialLimit));
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const value = Number(limit);
  const invalid = !Number.isFinite(value) || value <= 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await runAction(updateOpsExecutiveLimit(orgId, value, reason));
        toast.success("Executive limit saved", {
          description: "The change and your reason are on the operator record.",
        });
        setReason("");
      } catch (err) {
        toast.error("Could not save the limit", { description: describeError(err) });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="exec-limit">Executive requisition limit (₦)</Label>
        <Input
          id="exec-limit"
          type="number"
          min={0}
          step="0.01"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground">
          At or below this, the Executive may approve an FM, PM or operations
          requisition in place of the Managing Partner. Above it, the Managing
          Partner approves. The audit review and the payment approval apply
          either way.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="exec-limit-reason">Why is this changing?</Label>
        <Input
          id="exec-limit-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Board raised the Executive limit at the October review"
        />
      </div>
      <Button
        type="submit"
        variant="brand"
        disabled={pending || invalid || reason.trim().length < 10}
      >
        {pending ? "Saving…" : "Save limit"}
      </Button>
    </form>
  );
}
