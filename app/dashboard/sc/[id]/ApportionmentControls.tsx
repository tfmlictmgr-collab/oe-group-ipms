"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ruler, Equal, PencilLine, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNaira } from "@/lib/currency";
import { runAction, describeError } from "@/lib/run-action";
import type { ApportionMethod } from "@/lib/apportionment";
import { setApportionMethod, saveManualShares } from "./actions";

// How a budget is split, and — when it is split by hand — what each unit pays.
//
// ⚠️ The running variance is the whole point of this component. A manual
// apportionment is refused at generation unless it reconciles to the kobo with
// every unit stated, and a person discovering that only when they press
// Generate has already done the work twice. The figure shown here comes from
// `sc_manual_shares_state()` — the SAME function that refuses generation — so
// the screen cannot say "reconciles" over a guard that disagrees.
//
// Partial work saves. Fourteen units cannot be apportioned by hand in one
// submission, and a form that refuses an unbalanced set is a form people keep
// in a spreadsheet instead.

export type UnitRow = {
  id: string;
  label: string;
  factor: number;
  quantity: number;
  stated: number | null;
  computed: number;
};

const METHODS: {
  value: ApportionMethod;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "area",
    label: "By occupied space",
    hint: "Pro-rata by each unit's area × how many units the row stands for. The conventional split, and what every budget uses unless it says otherwise.",
    icon: <Ruler className="size-4" />,
  },
  {
    value: "equal",
    label: "Equally per unit",
    hint: "Every unit pays the same, whatever its size. How security, waste and grounds are actually shared on a small estate — the guard costs the same behind every door.",
    icon: <Equal className="size-4" />,
  },
  {
    value: "manual",
    label: "Stated per unit",
    hint: "You set each unit's amount. For a split negotiated in a lease, or one an apportionment workbook has already decided.",
    icon: <PencilLine className="size-4" />,
  },
];

export default function ApportionmentControls({
  budgetId,
  method,
  units,
  budgetTotal,
  invoiced,
}: {
  budgetId: string;
  method: ApportionMethod;
  units: UnitRow[];
  budgetTotal: number;
  invoiced: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(units.map((u) => [u.id, u.stated != null ? String(u.stated) : ""]))
  );

  // Computed live from what is typed, not from what was last saved — the
  // variance has to answer "if I saved this now", or it is telling someone
  // about a state they have already moved on from.
  const statedTotal = units.reduce((a, u) => {
    const n = Number(draft[u.id]);
    return a + (Number.isFinite(n) ? n : 0);
  }, 0);
  const unstated = units.filter((u) => {
    const v = draft[u.id];
    return v === undefined || v.trim() === "" || !Number.isFinite(Number(v));
  }).length;
  const variance = Math.round((budgetTotal - statedTotal) * 100) / 100;
  const reconciles = variance === 0 && unstated === 0 && units.length > 0;

  async function chooseMethod(next: ApportionMethod) {
    if (next === method) return;
    setBusy(true);
    try {
      await runAction(setApportionMethod(budgetId, next));
      toast.success("Apportionment method set");
      router.refresh();
    } catch (e) {
      toast.error("Could not change how this budget is split", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const payload = units
        .filter((u) => (draft[u.id] ?? "").trim() !== "")
        .map((u) => ({ unitId: u.id, amount: Number(draft[u.id]) }));
      const res = await runAction(saveManualShares(budgetId, payload));
      toast.success(
        res.reconciles
          ? "Shares saved — the split reconciles"
          : `Shares saved — ${formatNaira(Math.abs(res.variance))} still ${res.variance > 0 ? "to allocate" : "over the budget"}`
      );
      router.refresh();
    } catch (e) {
      toast.error("Could not save these shares", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  /** Fills every blank so the set lands exactly on the total. */
  function spreadRemainder() {
    const blanks = units.filter((u) => (draft[u.id] ?? "").trim() === "");
    if (blanks.length === 0 || variance <= 0) return;
    const each = Math.floor((variance / blanks.length) * 100) / 100;
    const next = { ...draft };
    blanks.forEach((u) => { next[u.id] = String(each); });
    // The rounding residual goes onto the LAST blank, so the set lands exactly
    // rather than a kobo short — the same reconciliation `apportion()` performs
    // for the computed methods, done here because a stated split has no weights
    // to push it onto.
    const spread = each * blanks.length;
    const residual = Math.round((variance - spread) * 100) / 100;
    if (residual !== 0) {
      const last = blanks[blanks.length - 1];
      next[last.id] = String(Math.round((each + residual) * 100) / 100);
    }
    setDraft(next);
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div>
          <p className="text-sm font-medium">How this budget is split</p>
          <p className="text-xs text-muted-foreground">
            {invoiced
              ? "This budget has been invoiced, so the method is now a matter of record — every invoice carries the method it was raised under."
              : "Recorded on the budget and snapshotted onto every invoice, so a statement can say how the figure was arrived at."}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {METHODS.map((m) => {
            const active = m.value === method;
            return (
              <button
                key={m.value}
                type="button"
                disabled={busy || invoiced}
                onClick={() => chooseMethod(m.value)}
                aria-pressed={active}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-[var(--brand)] bg-accent/40"
                    : "border-border hover:bg-accent/30",
                  (busy || invoiced) && "cursor-not-allowed opacity-60"
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {m.icon}
                  {m.label}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{m.hint}</span>
              </button>
            );
          })}
        </div>

        {method === "manual" && !invoiced && (
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Stated shares</p>
                <p className="text-xs text-muted-foreground">
                  Every unit needs an amount, and they have to add up to{" "}
                  {formatNaira(budgetTotal)} exactly. Partial work saves.
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {reconciles ? "Reconciles" : variance > 0 ? "Still to allocate" : "Over the budget"}
                </p>
                <p
                  className={cn(
                    "text-lg font-semibold tabular-nums",
                    reconciles ? "text-success" : "text-warning"
                  )}
                >
                  {formatNaira(Math.abs(variance))}
                </p>
                {unstated > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {unstated} unit{unstated === 1 ? "" : "s"} unstated
                  </p>
                )}
              </div>
            </div>

            <ul className="space-y-1.5">
              {units.map((u) => (
                <li key={u.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {u.label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {u.factor} m²{u.quantity > 1 ? ` × ${u.quantity}` : ""} · by
                      space this would be {formatNaira(u.computed)}
                    </span>
                  </span>
                  <Input
                    inputMode="decimal"
                    aria-label={`Share for ${u.label}`}
                    className="w-40 text-right tabular-nums"
                    placeholder="0.00"
                    value={draft[u.id] ?? ""}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [u.id]: e.target.value }))
                    }
                  />
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap justify-end gap-2">
              {variance > 0 && unstated > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={spreadRemainder}>
                  Spread {formatNaira(variance)} across the {unstated} unstated
                </Button>
              )}
              <Button type="button" size="sm" variant="brand" disabled={busy} onClick={save}>
                <Save /> {busy ? "Saving…" : "Save shares"}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Invoices cannot be generated until every unit is stated and the
              shares add up exactly. A short set would silently under-bill the
              property; an over set would bill more than the budget.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
