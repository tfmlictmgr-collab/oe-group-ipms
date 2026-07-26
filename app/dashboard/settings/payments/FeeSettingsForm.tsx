"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { updateFeeSettings } from "./actions";

// A worked example is shown live, because a percentage on its own is easy to
// mis-set and the consequence lands on a landlord's remittance.
const SAMPLE_RENT = 1_000_000;

export default function FeeSettingsForm({
  orgId,
  initialManagementFee,
  initialAdminFee,
}: {
  orgId: string;
  initialManagementFee: number;
  initialAdminFee: number;
}) {
  const router = useRouter();
  const [mgmt, setMgmt] = React.useState(String(initialManagementFee));
  const [admin, setAdmin] = React.useState(String(initialAdminFee));
  const [saving, setSaving] = React.useState(false);

  const m = Number(mgmt) || 0;
  const a = Number(admin) || 0;
  const totalPct = m + a;
  const retained = Math.round((SAMPLE_RENT * totalPct) / 100);
  const remitted = SAMPLE_RENT - retained;
  const overHundred = totalPct > 100;

  async function save() {
    setSaving(true);
    try {
      await updateFeeSettings(orgId, m, a);
      toast.success("Fee settings saved");
      router.refresh();
    } catch (e) {
      toast.error("Could not save fees", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mgmt-fee">Management fee (%)</Label>
          <Input
            id="mgmt-fee"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={mgmt}
            onChange={(e) => setMgmt(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-fee">Admin fee (%)</Label>
          <Input
            id="admin-fee"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={admin}
            onChange={(e) => setAdmin(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1 rounded-md bg-muted/60 px-4 py-3 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          On {formatNaira(SAMPLE_RENT)} of rent collected
        </p>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Retained ({totalPct}%)</span>
          <span className="font-medium tabular-nums">{formatNaira(retained)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Remitted to landlord</span>
          <span className="font-semibold tabular-nums">{formatNaira(remitted)}</span>
        </div>
      </div>

      {overHundred && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Fees total more than 100% — the landlord would receive nothing.
        </p>
      )}

      <Button variant="brand" onClick={save} disabled={saving || overHundred}>
        {saving ? "Saving…" : "Save fees"}
      </Button>
    </div>
  );
}
