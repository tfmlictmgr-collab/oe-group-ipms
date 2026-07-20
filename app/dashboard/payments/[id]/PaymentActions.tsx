"use client";

import { useState, useTransition } from "react";
import {
  verifyService,
  runPerformanceCheck,
  approvePayment,
  executeRemittance,
} from "./actions";

type Action = "verify" | "performance" | "approve" | "remit";

export default function PaymentActions({
  paymentId,
  status,
}: {
  paymentId: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: Action) {
    setError(null);
    startTransition(async () => {
      try {
        if (action === "verify") await verifyService(paymentId);
        else if (action === "performance") await runPerformanceCheck(paymentId);
        else if (action === "approve") await approvePayment(paymentId);
        else if (action === "remit") await executeRemittance(paymentId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
      }
    });
  }

  const btn =
    "rounded-lg btn-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

  let control: React.ReactNode = null;
  if (status === "pending_verification") {
    control = (
      <button className={btn} disabled={pending} onClick={() => run("verify")}>
        {pending ? "Working…" : "Verify service"}
      </button>
    );
  } else if (status === "verified") {
    control = (
      <button
        className={btn}
        disabled={pending}
        onClick={() => run("performance")}
      >
        {pending ? "Working…" : "Run performance check"}
      </button>
    );
  } else if (status === "recommended") {
    control = (
      <button className={btn} disabled={pending} onClick={() => run("approve")}>
        {pending ? "Working…" : "Approve payment"}
      </button>
    );
  } else if (status === "approved") {
    control = (
      <button className={btn} disabled={pending} onClick={() => run("remit")}>
        {pending ? "Working…" : "Execute remittance (SIMULATED)"}
      </button>
    );
  } else if (status === "rejected") {
    control = (
      <span className="text-sm font-medium text-red-600">
        Blocked — vendor failed the performance gate. No remittance possible.
      </span>
    );
  } else if (status === "remitted") {
    control = (
      <span className="text-sm font-medium text-emerald-700">
        Remitted (simulated). Flow complete.
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {control}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
