"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNaira } from "@/lib/currency";
import { simulatePayment } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

// Deliberately lets the amount be edited: an underpayment is the case worth
// being able to demonstrate, because it is the one that must NOT quietly mark
// an invoice paid.
export default function SimulatedCheckout({
  reference, amount,
}: {
  reference: string;
  amount: number;
}) {
  const [value, setValue] = React.useState(String(amount));
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const paid = Number(value);
  const short = Number.isFinite(paid) && paid > 0 && paid < amount;

  async function pay() {
    setBusy(true);
    try {
      const r = await runAction(simulatePayment(reference, paid));
      setDone(true);
      toast.success("Payment sent", { description: r.message });
      // Back to wherever this was raised from, which confirms and receipts it.
      setTimeout(() => { window.location.href = r.returnTo; }, 1200);
    } catch (e) {
      toast.error("Payment failed", { description: describeError(e) });
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="rounded-lg bg-success/10 px-4 py-3 text-center text-sm text-success">
        Sent. Returning to the portal…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="amt">Amount to pay</Label>
        <Input
          id="amt" inputMode="decimal" value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {short && (
          <p className="text-xs text-warning">
            {formatNaira(amount - paid)} short — this will be recorded as a part
            payment and flagged, not marked paid.
          </p>
        )}
      </div>
      <Button
        className="w-full" disabled={busy || !Number.isFinite(paid) || paid <= 0}
        onClick={pay}
      >
        {busy ? "Processing…" : `Pay ${formatNaira(paid || 0)}`}
      </Button>
    </div>
  );
}
