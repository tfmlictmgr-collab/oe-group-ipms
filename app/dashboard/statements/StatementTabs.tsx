"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type Tab = "charges" | "payments";

/**
 * The payer's statement as two tabs: what they were billed, and what they paid.
 *
 * Asked for directly (14 Sept 2026): the invoices and the payment history were
 * stacked on one page, and a tenant with dozens of payments scrolled past the
 * whole history to reach — or come back from — the charges. The same shape
 * My Rent already uses ("Demands / My homes"), so the two screens read alike.
 *
 * ⚠️ The inactive tab is hidden on SCREEN only (`hidden print:block`). A
 * printed statement is handed to a bank, an employer or a dispute; it has to
 * carry both what was billed and what was paid, whichever tab was open.
 */
export default function StatementTabs({
  chargesCount,
  paymentsCount,
  charges,
  payments,
  initialTab = "charges",
}: {
  chargesCount: number;
  paymentsCount: number;
  charges: React.ReactNode;
  payments: React.ReactNode;
  initialTab?: Tab;
}) {
  const [tab, setTab] = React.useState<Tab>(initialTab);

  return (
    <div className="space-y-4">
      <div role="tablist" data-print="screen-only" className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          role="tab"
          aria-selected={tab === "charges"}
          variant={tab === "charges" ? "default" : "outline"}
          onClick={() => setTab("charges")}
        >
          Service charges ({chargesCount})
        </Button>
        <Button
          size="sm"
          role="tab"
          aria-selected={tab === "payments"}
          variant={tab === "payments" ? "default" : "outline"}
          onClick={() => setTab("payments")}
        >
          Payment history ({paymentsCount})
        </Button>
      </div>

      <div role="tabpanel" className={tab === "charges" ? "space-y-4" : "hidden space-y-4 print:block"}>
        {charges}
      </div>
      <div role="tabpanel" className={tab === "payments" ? "space-y-4" : "hidden space-y-4 print:block"}>
        {payments}
      </div>
    </div>
  );
}
