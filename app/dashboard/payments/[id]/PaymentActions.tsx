"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ShieldCheck, Gauge, BadgeCheck, Send, Ban, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}: {
  paymentId: string;
  status: string;
  amount: number;
  vendorName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Action | null>(null);

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
    return (
      <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <Ban className="mt-0.5 size-4 flex-shrink-0" />
        Blocked — vendor failed the performance gate. No remittance possible.
      </p>
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

  const config: Record<string, { action: Action; label: string; icon: React.ReactNode }> = {
    pending_verification: { action: "verify", label: "Verify service", icon: <ShieldCheck /> },
    verified: { action: "performance", label: "Run performance check", icon: <Gauge /> },
    recommended: { action: "approve", label: "Approve payment", icon: <BadgeCheck /> },
    approved: { action: "remit", label: "Send payment", icon: <Send /> },
  };

  const step = config[status];
  if (!step) return null;

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

  if (!CONFIRMED_ACTIONS.has(step.action)) return button;

  const copy = CONFIRM_COPY[step.action as "approve" | "remit"];

  return (
    <>
      {button}
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
