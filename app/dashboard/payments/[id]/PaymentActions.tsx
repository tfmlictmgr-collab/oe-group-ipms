"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ShieldCheck, Gauge, BadgeCheck, Send, Ban, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export default function PaymentActions({
  paymentId,
  status,
}: {
  paymentId: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();

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

  return (
    <Button variant="brand" disabled={pending} onClick={() => run(step.action)}>
      {step.icon}
      {pending ? "Working…" : step.label}
    </Button>
  );
}
