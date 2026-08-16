import { Check, X, Circle, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatNaira, tierLabel, type ChainState } from "@/lib/approvals/chain";

/**
 * The three stages of a payment, and where it has got to.
 *
 * Shows the amount each stage was decided AT, not only the current one — when
 * those differ the chain is broken and the difference is the whole explanation,
 * so hiding it would leave "awaiting re-approval" looking like a glitch.
 */
export default function ChainTrail({ state }: { state: ChainState }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-muted-foreground">
          Requires {tierLabel(state.requiredTier)}
        </span>
        <span className="text-lg font-medium tabular-nums">
          {formatNaira(state.amount)}
        </span>
      </div>

      {state.amountChangedAfterApproval && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              The amount changed after this was approved.
            </span>{" "}
            Every stage has to be approved again at {formatNaira(state.amount)},
            because the new figure may need a more senior approver than the old one.
          </p>
        </div>
      )}

      <ol className="space-y-2">
        {state.stages.map((s) => {
          const done = s.decision === "approved";
          const refused = s.decision === "rejected";
          const stale = done && s.decidedAmount !== state.amount;

          return (
            <li
              key={s.stageOrder}
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5",
                done && !stale && "border-success/40 bg-success/5",
                refused && "border-destructive/40 bg-destructive/5",
                stale && "border-warning/40 bg-warning/5"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-5 flex-shrink-0 items-center justify-center rounded-full",
                  done && !stale && "bg-success/15 text-success",
                  refused && "bg-destructive/15 text-destructive",
                  stale && "bg-warning/15 text-warning",
                  !s.decision && "bg-muted text-muted-foreground"
                )}
              >
                {refused ? (
                  <X className="size-3.5" />
                ) : done ? (
                  <Check className="size-3.5" />
                ) : (
                  <Circle className="size-2.5 fill-current" />
                )}
              </span>

              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">
                  {s.stageOrder}. {s.label}
                  {s.tierResolved && s.requiredTier ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {tierLabel(s.requiredTier)}
                    </span>
                  ) : null}
                </p>

                {s.decision ? (
                  <p className="text-xs text-muted-foreground">
                    {refused ? "Refused" : "Approved"} by{" "}
                    {s.actorName ?? "someone no longer listed"}
                    {s.decidedAt
                      ? ` · ${new Date(s.decidedAt).toLocaleDateString("en-NG", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}`
                      : ""}
                    {stale && s.decidedAmount != null
                      ? ` · at ${formatNaira(s.decidedAmount)}`
                      : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Awaiting a decision</p>
                )}

                {s.reason ? (
                  <p className="pt-1 text-xs text-foreground">“{s.reason}”</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-muted-foreground">
        Disbursement is a fourth step held by finance alone — it is not an
        approval and cannot stand in for a missing one.
      </p>
    </div>
  );
}
