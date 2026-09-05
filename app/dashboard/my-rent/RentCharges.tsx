"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CreditCard, ExternalLink, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatMoney } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { payMyRent } from "./actions";

export type RentChargeRow = {
  charge_id: string;
  property_name: string;
  unit_label: string;
  period_start: string;
  period_end: string;
  due_date: string | null;
  amount: number | string;
  amount_paid: number | string;
  outstanding: number | string;
  currency: string;
  status: string;
  open_intent_reference: string | null;
};

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "—";

export default function RentCharges({ charges }: { charges: RentChargeRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function pay(charge: RentChargeRow) {
    setBusy(charge.charge_id);
    try {
      const r = await runAction(payMyRent(charge.charge_id));
      // A real gateway hands back a hosted checkout page; the simulated one
      // has none, and its own /pay/[reference] page stands in for it.
      const url = r.checkoutUrl ?? `/pay/${encodeURIComponent(r.reference)}`;
      window.location.href = url;
    } catch (e) {
      toast.error(messageOf(e, "That payment could not be opened."), {
        description: hintOf(e),
        duration: Infinity,
        closeButton: true,
      });
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      {charges.map((c) => {
        const outstanding = Number(c.outstanding);
        const settled = outstanding <= 0;
        return (
          <Card key={c.charge_id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
              <div className="min-w-0 space-y-1">
                <p className="font-medium leading-snug">
                  {fmtDate(c.period_start)} – {fmtDate(c.period_end)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.property_name} · Unit {c.unit_label}
                  {c.due_date ? ` · due ${fmtDate(c.due_date)}` : ""}
                </p>
                {Number(c.amount_paid) > 0 && !settled && (
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(c.amount_paid, c.currency)} of{" "}
                    {formatMoney(c.amount, c.currency)} paid so far
                  </p>
                )}
              </div>

              <div className="flex flex-shrink-0 items-center gap-3">
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">
                    {formatMoney(settled ? c.amount : outstanding, c.currency)}
                  </p>
                  <StatusBadge status={c.status} />
                </div>

                {settled ? (
                  <span className="flex items-center gap-1.5 text-sm text-success">
                    <CheckCircle2 className="size-4" /> Paid
                  </span>
                ) : (
                  <Button
                    variant="brand"
                    disabled={busy === c.charge_id}
                    onClick={() => pay(c)}
                  >
                    {busy === c.charge_id ? (
                      <Loader2 className="animate-spin" />
                    ) : c.open_intent_reference ? (
                      <ExternalLink />
                    ) : (
                      <CreditCard />
                    )}
                    {busy === c.charge_id
                      ? "Opening…"
                      : c.open_intent_reference
                        ? "Continue payment"
                        : "Pay now"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
