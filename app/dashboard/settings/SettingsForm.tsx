"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePaymentSettings } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

const naira = (n: number) =>
  `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

/**
 * The payment gate: the KPI floor, and the two rungs of the approval ladder.
 *
 * ⚠️ `tier1_threshold_amount` had NO FIELD until 22 Aug 2026. It has been read
 * by `resolve_required_tier()` since 0151 and written by nothing, so it sat at
 * its ₦100,000 default on every organisation while this screen showed a single
 * "Finance approval threshold" and implied that was the whole rule. A control
 * nobody can see is a control nobody is administering.
 */
export default function SettingsForm({
  orgId,
  initialMinScore,
  initialThreshold,
  initialTier1Threshold,
}: {
  orgId: string;
  initialMinScore: number;
  initialThreshold: number;
  initialTier1Threshold: number;
}) {
  const [minScore, setMinScore] = useState(String(initialMinScore));
  const [threshold, setThreshold] = useState(String(initialThreshold));
  const [tier1, setTier1] = useState(String(initialTier1Threshold));
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const t1 = Number(tier1);
  const t2 = Number(threshold);
  const ladderInverted = Number.isFinite(t1) && Number.isFinite(t2) && t1 >= t2;
  const reasonTooShort = reason.trim().length < 10;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await runAction(
          updatePaymentSettings(orgId, Number(minScore), t2, t1, reason)
        );
        toast.success("Payment gate settings saved", {
          description: "The change and your reason are on the operator record.",
        });
        setReason("");
      } catch (err) {
        toast.error("Could not save settings", {
          description: describeError(err),
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="min-score">Minimum performance score (KPI gate)</Label>
        <Input
          id="min-score"
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground">
          Vendors below this composite score are blocked from remittance.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Approval ladder</p>
          <p className="text-xs text-muted-foreground">
            Which band an amount falls into decides who must give the final
            approval — stage 3 of the chain. Signing off that the work was done
            (stage 1) and the audit check (stage 2) happen on every payment
            regardless of size.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tier1">Tier 1 limit (₦)</Label>
            <Input
              id="tier1"
              type="number"
              min={0}
              step="0.01"
              value={tier1}
              onChange={(e) => setTier1(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At or below this, a tier‑1 payment approver can give final
              approval.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="threshold">Tier 2 limit (₦)</Label>
            <Input
              id="threshold"
              type="number"
              min={0}
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Above this, only an executive or a tier‑3 approver can clear it.
            </p>
          </div>
        </div>

        {ladderInverted ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            The tier 1 limit must be below the tier 2 limit — otherwise there is
            no tier 2 band at all, and every payment above tier 1 jumps straight
            to needing an executive.
          </p>
        ) : (
          <dl className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                Up to {naira(t1)}
              </dt>
              <dd className="font-medium">Tier 1 approver, and above</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {naira(t1)} – {naira(t2)}
              </dt>
              <dd className="font-medium">
                Tier 2 approver, an administrator, or an executive
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Above {naira(t2)}</dt>
              <dd className="font-medium">Tier 3 approver or an executive</dd>
            </div>
          </dl>
        )}

        {/* Decisions 9 and 16, stated where someone might otherwise go looking
            for a field to change them. These are not preferences. */}
        <p className="text-xs text-muted-foreground">
          An executive always counts as tier 3 and an administrator as tier 2 —
          set by their role, not by a field here, because approving against a
          limit you can lift yourself is not an approval. A payment approver’s
          own tier is set against that person under People.
        </p>
      </div>

      {/* Required by `operator_set_payment_gate`, and required for a reason:
          this is the one screen where a change quietly widens who may release
          money without a second pair of hands. The RPC refuses under 10
          characters. */}
      <div className="space-y-1.5">
        <Label htmlFor="gate-reason">Why is this changing?</Label>
        <Input
          id="gate-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Board raised the OEA limit at the August review"
        />
        <p className="text-xs text-muted-foreground">
          Recorded against this organisation with the before and after, where
          the organisation itself can read it. It is what an auditor reads when
          they ask why the ladder moved.
        </p>
      </div>

      <Button
        type="submit"
        variant="brand"
        disabled={pending || ladderInverted || reasonTooShort}
      >
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
