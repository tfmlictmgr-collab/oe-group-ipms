"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf } from "@/lib/run-action";
import { approvePayments, type BatchOutcome } from "./actions";

export type PaymentRow = {
  id: string;
  invoice_reference: string | null;
  amount: number | string;
  status: string;
  vendor_name: string | null;
  ticket_reference: string | null;
};

/**
 * The approval queue — everything sitting at `recommended`, selectable.
 *
 * Only `recommended` payments appear here. The gate is a sequence (verify →
 * performance → approve → remit) and offering a checkbox against a payment
 * three steps back would invite a finance lead to tick it and be told no,
 * twenty times over. The full list below still shows every payment at every
 * stage; this is the subset there is a decision to make about.
 */
export default function BatchApprove({
  rows,
  limit,
}: {
  rows: PaymentRow[];
  limit: { threshold: number; unlimited: boolean } | null;
}) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [outcomes, setOutcomes] = React.useState<BatchOutcome[] | null>(null);

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allPicked = rows.length > 0 && picked.size === rows.length;
  const selected = rows.filter((r) => picked.has(r.id));
  const total = selected.reduce((a, r) => a + Number(r.amount), 0);

  // Shown BEFORE the action runs, not discovered from its refusals. The
  // database is still the enforcement — this only means a finance lead sees
  // which line is going to need the MD before they click, rather than after.
  const overLimit =
    limit && !limit.unlimited
      ? selected.filter((r) => Number(r.amount) > limit.threshold)
      : [];

  async function run() {
    setBusy(true);
    setOutcomes(null);
    try {
      const r = await runAction(approvePayments(Array.from(picked)));
      setOutcomes(r.outcomes);
      setPicked(new Set());
      if (r.refused === 0) {
        toast.success(`${r.approved} payment${r.approved === 1 ? "" : "s"} approved.`);
      } else {
        // Not an error toast: a partial batch is the expected shape, and
        // colouring it red would train people to ignore it.
        toast.message(`${r.approved} approved · ${r.refused} left as they were`, {
          description: "The reasons are listed below each refused invoice.",
        });
      }
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e, "That batch could not be approved."), {
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  const refused = (outcomes ?? []).filter((o) => !o.approved);

  if (rows.length === 0 && !outcomes) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Awaiting your approval</p>
            <p className="text-xs text-muted-foreground">
              {rows.length} invoice{rows.length === 1 ? "" : "s"} through the
              verification and performance gates.
              {limit && !limit.unlimited
                ? ` Your limit is ${formatNaira(limit.threshold)}.`
                : limit?.unlimited
                  ? " You can approve any amount."
                  : ""}
            </p>
          </div>
          {rows.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))
              }
            >
              {allPicked ? "Clear" : "Select all"}
            </Button>
          )}
        </div>

        {rows.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((r) => {
              const outcome = (outcomes ?? []).find((o) => o.paymentId === r.id);
              const over =
                limit && !limit.unlimited && Number(r.amount) > limit.threshold;
              return (
                <li key={r.id} className="space-y-1.5 p-3">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-4 flex-shrink-0 accent-[var(--brand)]"
                      checked={picked.has(r.id)}
                      onChange={() => toggle(r.id)}
                      disabled={busy}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {r.vendor_name ?? "—"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.invoice_reference ?? "no reference"}
                        {/* The work order this invoice is for. Its absence is
                            the thing worth noticing, so it is stated rather
                            than left blank. */}
                        {r.ticket_reference
                          ? ` · job ${r.ticket_reference}`
                          : " · no work order linked"}
                      </span>
                    </span>
                    <span className="flex-shrink-0 text-right text-sm font-semibold tabular-nums">
                      {formatNaira(r.amount)}
                    </span>
                  </label>

                  {over && (
                    <p className="flex items-start gap-1.5 pl-7 text-xs text-warning">
                      <AlertCircle className="mt-0.5 size-3.5 flex-shrink-0" />
                      Above your limit — an administrator or the MD must approve
                      this one.
                    </p>
                  )}
                  {outcome && !outcome.approved && (
                    <p className="pl-7 text-xs text-destructive">{outcome.reason}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {picked.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
            <p className="text-sm">
              <span className="font-medium">{picked.size} selected</span>
              <span className="text-muted-foreground">
                {" "}
                · {formatNaira(total)}
                {overLimit.length > 0
                  ? ` · ${overLimit.length} above your limit`
                  : ""}
              </span>
            </p>
            <Button variant="brand" disabled={busy} onClick={run}>
              {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              {busy ? "Approving…" : `Approve ${picked.size}`}
            </Button>
          </div>
        )}

        {refused.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {refused.length} invoice{refused.length === 1 ? " was" : "s were"} left
            exactly as {refused.length === 1 ? "it was" : "they were"} — nothing
            partial was recorded against{" "}
            {refused.length === 1 ? "it" : "them"}.{" "}
            <Link href="/dashboard/payments" className="underline">
              Open one to see the full gate.
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
