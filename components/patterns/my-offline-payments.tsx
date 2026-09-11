import Link from "next/link";
import { Landmark, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/currency";
import {
  METHOD_LABEL, STATUS_LABEL, STATUS_TONE,
  type ClaimStatus, type OfflineMethod,
} from "@/lib/offline-payments";

type Row = {
  claim_id: string;
  reference: string;
  method: OfflineMethod;
  claimed_amount: number | string;
  confirmed_amount: number | string | null;
  currency: string;
  paid_on: string;
  status: ClaimStatus;
  what: string | null;
  stages_done: number;
  stages_total: number;
  current_stage_label: string | null;
  decision_reason: string | null;
  posted_at: string | null;
};

const TONE = { info: "info", success: "success", danger: "destructive", warning: "warning" } as const;

/**
 * "Payments I have reported", for the person who reported them.
 *
 * Rendered on My Rent and on the tenant's service-charge view, because those
 * are the two screens where a person is looking at what they owe and needs to
 * see that they have already told us about a payment against it. A claim that
 * is only visible on a staff queue is a claim the payer cannot track, and they
 * would report it a second time.
 *
 * Reads `my_offline_payment_claims()` — definer, self-scoped to the caller as
 * payer OR recorder, exactly as `my_rent_charges()` is.
 */
export async function MyOfflinePayments({ showEmpty = false }: { showEmpty?: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("my_offline_payment_claims");
  const rows = (data ?? []) as Row[];

  if (rows.length === 0 && !showEmpty) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Payments you have reported</h2>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/payments/offline/new">
            <Landmark className="size-4" />
            Make / report a bank transfer
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Paid by transfer or at the bank? Report it here with your receipt and we
          will apply it to your account once we have checked it.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.claim_id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono font-medium">{r.reference}</span>
                    <Badge variant={TONE[STATUS_TONE[r.status]]}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {METHOD_LABEL[r.method]} on{" "}
                    {new Date(r.paid_on).toLocaleDateString("en-GB", {
                      day: "numeric", month: "short", year: "numeric",
                    })}
                    {r.what ? ` · ${r.what}` : ""}
                    {r.posted_at
                      ? " · applied to your account"
                      : r.status === "submitted"
                        ? ` · ${r.stages_done} of ${r.stages_total} checks done`
                        : ""}
                  </p>
                  {/* The reviewer's own words, on the screen the payer is on.
                      A decision they are told about only by email is a decision
                      they cannot act on from here. */}
                  {r.decision_reason && !r.posted_at && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {r.decision_reason}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums text-sm font-semibold">
                    {formatMoney(Number(r.confirmed_amount ?? r.claimed_amount), r.currency)}
                  </span>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/dashboard/payments/offline/${r.claim_id}`}>
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
