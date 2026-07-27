"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePaymentSettings } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export default function SettingsForm({
  orgId,
  initialMinScore,
  initialThreshold,
}: {
  orgId: string;
  initialMinScore: number;
  initialThreshold: number;
}) {
  const [minScore, setMinScore] = useState(String(initialMinScore));
  const [threshold, setThreshold] = useState(String(initialThreshold));
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await runAction(updatePaymentSettings(orgId, Number(minScore), Number(threshold)));
        toast.success("Payment gate settings saved");
      } catch (err) {
        toast.error("Could not save settings", {
          description: describeError(err),
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
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
          />
          <p className="text-xs text-muted-foreground">
            Vendors below this composite score are blocked from remittance.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="threshold">Finance approval threshold (₦)</Label>
          <Input
            id="threshold"
            type="number"
            min={0}
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Payments above this amount require an administrator to approve.
          </p>
        </div>
      </div>

      <Button type="submit" variant="brand" disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
