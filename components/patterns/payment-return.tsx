"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { formatMoney } from "@/lib/currency";
import type { ActionResult } from "@/lib/action-result";

type Check = ActionResult<{ state: "paid" | "pending" | "failed"; amount?: number; currency?: string }>;

/**
 * Shown when a payer lands back here from the gateway's checkout
 * (`?ref=…`, plus Paystack's own `trxref`/`reference`).
 *
 * ⚠️ 11 Sept 2026. Until now nothing happened on the return: the page rendered
 * the demand as it stood, and the only thing that could ever change it was a
 * webhook from the gateway — which, on staging, had never once arrived. So a
 * tenant who had just paid ₦100,000,000 was shown the same ₦100,000,000
 * outstanding, a "Due" badge, and a "Continue payment" button. This asks the
 * gateway server-to-server (never trusting the URL), records the payment if
 * it holds it, and says plainly which of three things is true.
 */
export function PaymentReturn({
  reference,
  check,
}: {
  reference: string;
  check: (reference: string) => Promise<Check>;
}) {
  const router = useRouter();
  const [result, setResult] = React.useState<Check | null>(null);
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    check(reference)
      .then((r) => {
        setResult(r);
        // Re-read the page so the balance beneath shows what was just recorded.
        // 📌 The gateway's parameters are deliberately LEFT in the address: the
        // first draft stripped them, the server re-rendered without them, and
        // this banner unmounted the moment it had something to say. A reload
        // re-asks the gateway, which is idempotent and quick once recorded.
        router.refresh();
      })
      .catch(() =>
        setResult({
          ok: false,
          message: "We could not reach the payment gateway to confirm this yet.",
          hint: "If you completed it, it will be recorded automatically once the gateway confirms it — you do not need to pay again.",
        } as Check)
      );
  }, [check, reference, router]);

  if (!result) {
    return (
      <Banner tone="info" icon={<Loader2 className="size-4 animate-spin" />}>
        Confirming your payment with the payment gateway…
      </Banner>
    );
  }
  if (!result.ok) {
    return (
      <Banner tone="warning" icon={<Clock className="size-4" />}>
        {result.message} {result.hint} Reference <span className="font-mono">{reference}</span>.
      </Banner>
    );
  }
  if (result.data.state === "paid") {
    return (
      <Banner tone="success" icon={<CheckCircle2 className="size-4" />}>
        Payment received
        {result.data.amount != null && ` — ${formatMoney(result.data.amount, result.data.currency)}`}. It is
        recorded against your account and a receipt is on its way to your email.
      </Banner>
    );
  }
  if (result.data.state === "failed") {
    return (
      <Banner tone="danger" icon={<XCircle className="size-4" />}>
        The gateway reports that this payment did not go through, so nothing was taken. You can try
        again below.
      </Banner>
    );
  }
  return (
    <Banner tone="warning" icon={<Clock className="size-4" />}>
      The gateway has not confirmed this payment yet. If you completed it, it will be recorded
      automatically as soon as it does — you do not need to pay again. Reference{" "}
      <span className="font-mono">{reference}</span>.
    </Banner>
  );
}

function Banner({
  tone, icon, children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls = {
    info: "border-info/30 bg-info/10 text-info-onTint",
    success: "border-success/30 bg-success/10 text-success-onTint",
    warning: "border-warning/30 bg-warning/10 text-warning-onTint",
    danger: "border-destructive/30 bg-destructive/10 text-destructive-onTint",
  }[tone];
  return (
    <div role="status" className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${cls}`}>
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <p>{children}</p>
    </div>
  );
}
