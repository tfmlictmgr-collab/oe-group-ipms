"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ShieldCheck, Gauge, BadgeCheck, Send, Ban, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  remit: "Remittance executed (simulated)",
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
        if (action === "verify") await verifyService(paymentId);
        else if (action === "performance") await runPerformanceCheck(paymentId);
        else if (action === "approve") await approvePayment(paymentId);
        else if (action === "remit") await executeRemittance(paymentId);
        toast.success(LABELS[action]);
      } catch (e) {
        // The DB state machine (migration 0010) is the real gate — surface its
        // reason rather than a generic failure.
        toast.error("Action blocked", {
          description: e instanceof Error ? e.message : "Unexpected error.",
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
        Remitted (simulated). Flow complete.
      </p>
    );
  }

  const config: Record<string, { action: Action; label: string; icon: React.ReactNode }> = {
    pending_verification: { action: "verify", label: "Verify service", icon: <ShieldCheck /> },
    verified: { action: "performance", label: "Run performance check", icon: <Gauge /> },
    recommended: { action: "approve", label: "Approve payment", icon: <BadgeCheck /> },
    approved: { action: "remit", label: "Execute remittance (simulated)", icon: <Send /> },
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
