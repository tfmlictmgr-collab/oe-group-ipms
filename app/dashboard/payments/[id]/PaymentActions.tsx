"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ShieldCheck, Gauge, BadgeCheck, Send, Ban, CheckCircle2, XCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { formatNaira } from "@/lib/currency";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import {
  verifyService,
  runPerformanceCheck,
  approvePayment,
  executeRemittance,
  rejectPayment,
  reopenPayment,
} from "./actions";

type Action = "verify" | "performance" | "approve" | "remit";

const LABELS: Record<Action, string> = {
  verify: "Service verified",
  performance: "Performance check complete",
  approve: "Payment approved",
  remit: "Transfer sent",
};

// Only these two move (or authorise moving) real money — B4's gate. Verify
// and the performance check are evidence-gathering steps with nothing to
// undo if clicked in error; approve and remit are the ones a stray tap must
// not be able to fire on its own.
const CONFIRMED_ACTIONS = new Set<Action>(["approve", "remit"]);

export default function PaymentActions({
  paymentId,
  status,
  amount,
  vendorName,
  rejectedReason,
  canReopen,
  canRemit,
}: {
  paymentId: string;
  status: string;
  amount: number;
  vendorName: string;
  /** Why it was refused. Null on anything not rejected. */
  rejectedReason?: string | null;
  /** Finance or an administrator — the trigger enforces it regardless. */
  canReopen?: boolean;
  /**
   * Whether this viewer may RELEASE funds — finance_approver only, since 0142.
   * The database refuses everyone else regardless; this exists so an
   * administrator is not shown a "Send payment" button that is certain to be
   * refused, which reads as a broken system rather than a deliberate boundary.
   */
  canRemit?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [reasoning, setReasoning] = useState<"reject" | "reopen" | null>(null);
  const [reason, setReason] = useState("");

  function runReason(kind: "reject" | "reopen") {
    startTransition(async () => {
      try {
        await runAction(
          kind === "reject"
            ? rejectPayment(paymentId, reason)
            : reopenPayment(paymentId, reason)
        );
        toast.success(kind === "reject" ? "Invoice rejected — the vendor has been told" : "Invoice reopened");
        setReasoning(null);
        setReason("");
      } catch (e) {
        toast.error(messageOf(e, "That could not be done."), {
          description: hintOf(e), duration: Infinity, closeButton: true,
        });
      }
    });
  }

  function run(action: Action) {
    startTransition(async () => {
      try {
        if (action === "verify") await runAction(verifyService(paymentId));
        else if (action === "performance") await runAction(runPerformanceCheck(paymentId));
        else if (action === "approve") await runAction(approvePayment(paymentId));
        else if (action === "remit") {
          const r = await runAction(executeRemittance(paymentId));
          // A `pending` transfer has been accepted but has NOT moved money yet;
          // saying "sent" would be a claim the gateway has not made.
          if (r.status === "pending") {
            toast.info("Transfer accepted — awaiting confirmation", {
              description: `${r.reference}. The ledger will be updated when the bank confirms it. Do not send again.`,
              duration: Infinity,
              closeButton: true,
            });
          } else {
            toast.success("Transfer sent", { description: r.reference });
          }
          return;
        }
        toast.success(LABELS[action]);
      } catch (e) {
        // The gate's own reason, not a generic failure. Kept on screen: these
        // say which step is missing, and that cannot be acted on in four seconds.
        toast.error(messageOf(e, "That step could not be completed."), {
          description: hintOf(e),
          duration: Infinity,
          closeButton: true,
        });
      }
    });
  }

  if (status === "rejected") {
    // ⚠️ This used to read "Blocked — vendor failed the performance gate. No
    // remittance possible." and offer nothing: no reason, no route. An invoice
    // refused in error — a mis-click, or a performance score that was low only
    // because an evaluation had not landed yet — was unrecoverable, for work
    // that had genuinely been done.
    return (
      <div className="space-y-3">
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="flex items-start gap-2 font-medium">
            <Ban className="mt-0.5 size-4 flex-shrink-0" />
            Rejected — no remittance is possible while it stands.
          </p>
          {rejectedReason && <p className="mt-1.5 pl-6">{rejectedReason}</p>}
        </div>

        <p className="text-xs text-muted-foreground">
          The vendor was told, and can correct and resubmit an invoice for this
          job from My Work.
          {canReopen
            ? " If the rejection itself was wrong, reopen it — the invoice returns to service verification and the gate is walked again from the start."
            : " If the rejection itself was wrong, finance or an administrator can reopen it."}
        </p>

        {canReopen && (
          <>
            <Button variant="outline" disabled={pending} onClick={() => setReasoning("reopen")}>
              <RotateCcw /> Reopen this invoice
            </Button>

            <AlertDialog open={reasoning === "reopen"} onOpenChange={(o) => !o && setReasoning(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reopen this invoice?</AlertDialogTitle>
                  <AlertDialogDescription>
                    It goes back to service verification with the verification and
                    performance flags cleared — nothing from before the rejection
                    carries over. The vendor is told.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="mt-4 space-y-2">
                  <Label htmlFor="reopen-reason">Why is this being reversed?</Label>
                  <Input
                    id="reopen-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. The tenant rating landed after the check ran — score is now 88"
                  />
                  <p className="text-xs text-muted-foreground">At least 10 characters.</p>
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Leave it rejected</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => { e.preventDefault(); runReason("reopen"); }}
                  >
                    {pending ? "Reopening…" : "Reopen"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    );
  }

  if (status === "remitted") {
    return (
      <p className="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
        <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0" />
        Remitted. The transfer has been sent and posted to the ledger.
      </p>
    );
  }

  // ⚠️ `recommended` HAS NO BUTTON HERE, deliberately (22 Aug 2026).
  //
  // It used to offer "Approve payment", which called the pre-chain
  // `approvePayment` action — and that button could never succeed. Since 0151
  // approval is the CHAIN's outcome: `apply_chain_outcome_to_payment()` moves
  // the payment to `approved` the instant stage 3 clears, and
  // `enforce_payment_transition` refuses the status change outright while the
  // chain is incomplete. So the button had exactly two outcomes — refused
  // because the chain was unfinished, or refused because the trigger had
  // already approved it — and it emitted the app layer's own stale message
  // ("Only finance, an administrator or an executive may approve payments")
  // to a payment approver, the one role that exists to action stage 3.
  //
  // The chain card above this one is the approval surface. Two surfaces for
  // one decision is how a person ends up believing the system is broken when
  // it is working.
  const config: Record<string, { action: Action; label: string; icon: React.ReactNode }> = {
    pending_verification: { action: "verify", label: "Verify service", icon: <ShieldCheck /> },
    verified: { action: "performance", label: "Run performance check", icon: <Gauge /> },
    approved: { action: "remit", label: "Send payment", icon: <Send /> },
  };

  const step = config[status];
  if (!step) return null;

  // ⚠️ Rejecting is offered at EVERY live stage, beside the forward one.
  // Before 0136 the only way an invoice could be refused was by failing the
  // automated performance check — so a verifier looking at work that plainly
  // had not been done had no button for that, and the honest options were to
  // leave it sitting or to run a check they knew would fail. A refusal is a
  // decision someone makes; it should not have to be smuggled through a score.
  const rejectControl = (
    <>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() => setReasoning("reject")}
        className="text-destructive hover:text-destructive"
      >
        <XCircle /> Reject
      </Button>

      <AlertDialog open={reasoning === "reject"} onOpenChange={(o) => !o && setReasoning(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              {vendorName} is told, with your reason, and can correct and
              resubmit for the same job. Finance or an administrator can reopen
              it if this turns out to be wrong.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="reject-reason">Why?</Label>
            <Input
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The stairwell lighting is still out — this job is not complete"
            />
            <p className="text-xs text-muted-foreground">
              At least 10 characters. The vendor reads this, so make it something
              they can act on.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => { e.preventDefault(); runReason("reject"); }}
            >
              {pending ? "Rejecting…" : "Reject invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  const CONFIRM_COPY: Record<"approve" | "remit", { title: string; description: string; action: string }> = {
    approve: {
      title: "Approve this payment?",
      description: `You are approving ${formatNaira(amount)} to ${vendorName}. This clears the last gate before the transfer can be sent — it does not itself move money, but it is the decision that authorises it.`,
      action: "Approve payment",
    },
    remit: {
      title: "Send this payment?",
      description: `This sends ${formatNaira(amount)} to ${vendorName} now. Once sent it cannot be recalled from here — a mistaken transfer has to be chased with the bank, not undone in the app.`,
      action: "Send payment",
    },
  };

  // Approved, and not this viewer's to release. An administrator who approved
  // it is meant to stop here, so they are told why rather than shown a button
  // the database is certain to refuse — which reads as a broken system rather
  // than a deliberate boundary. Rejecting is still theirs.
  if (step.action === "remit" && !canRemit) {
    return (
      <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-md bg-info/10 px-3 py-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 flex-shrink-0 text-info" />
          <span>
            Approved, and waiting on finance to release it. Oversight authorises; finance
            disburses — and whoever approved a payment is never the one who sends it.
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">{rejectControl}</div>
      </div>
    );
  }

  const button = (
    <Button
      variant="brand"
      disabled={pending}
      onClick={
        CONFIRMED_ACTIONS.has(step.action)
          ? () => setConfirming(step.action)
          : () => run(step.action)
      }
    >
      {step.icon}
      {pending ? "Working…" : step.label}
    </Button>
  );

  if (!CONFIRMED_ACTIONS.has(step.action)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {button}
        {rejectControl}
      </div>
    );
  }

  const copy = CONFIRM_COPY[step.action as "approve" | "remit"];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {button}
        {rejectControl}
      </div>
      <AlertDialog open={confirming === step.action} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={step.action === "remit" ? "destructive" : "brand"}
              onClick={() => {
                setConfirming(null);
                run(step.action);
              }}
            >
              {copy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
