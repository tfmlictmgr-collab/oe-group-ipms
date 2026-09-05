"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CreditCard, ExternalLink, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { payMyServiceCharge } from "./actions";

export type ServiceChargeRow = {
  charge_id: string;
  property_or_unit: string | null;
  billing_period: string | null;
  due_date: string | null;
  amount: number | string;
  amount_paid: number | string;
  outstanding: number | string;
  apportionment_pct: number | string | null;
  status: string;
  open_intent_reference: string | null;
};

const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;

/**
 * The payer's own service-charge invoices, each with a way to settle it.
 *
 * Written against `my_service_charges()` and shaped like `RentCharges`
 * deliberately: a tenant who has paid rent once should recognise this screen
 * without reading it, and the two should not diverge in what "outstanding"
 * looks like.
 */
export default function ServiceCharges({ charges }: { charges: ServiceChargeRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function pay(charge: ServiceChargeRow) {
    setBusy(charge.charge_id);
    try {
      const r = await runAction(payMyServiceCharge(charge.charge_id));
      // A real gateway hands back a hosted checkout page; the simulated one has
      // none, and its own /pay/[reference] page stands in for it.
      window.location.href = r.checkoutUrl ?? `/pay/${encodeURIComponent(r.reference)}`;
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
        const due = fmtDate(c.due_date);
        return (
          <Card key={c.charge_id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
              <div className="min-w-0 space-y-1">
                <p className="font-medium leading-snug">
                  {c.billing_period ?? "Service charge"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.property_or_unit ?? "—"}
                  {c.apportionment_pct != null
                    ? ` · ${Number(c.apportionment_pct).toFixed(2)}% share`
                    : ""}
                  {due ? ` · due ${due}` : ""}
                </p>
                {Number(c.amount_paid) > 0 && !settled && (
                  <p className="text-xs text-muted-foreground">
                    {formatNaira(c.amount_paid)} of {formatNaira(c.amount)} paid so far
                  </p>
                )}
              </div>

              <div className="flex flex-shrink-0 items-center gap-3">
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">
                    {formatNaira(settled ? c.amount : outstanding)}
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
