"use client";

import { useState, useTransition } from "react";
import { generateInvoices } from "./actions";

export default function GenerateButton({
  budgetId,
  alreadyInvoiced,
}: {
  budgetId: string;
  alreadyInvoiced: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        await generateInvoices(budgetId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate invoices");
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-sm text-red-600">{error}</span>}
      <button
        onClick={handleClick}
        disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending
          ? "Generating…"
          : alreadyInvoiced
            ? "Regenerate invoices"
            : "Generate invoices"}
      </button>
    </div>
  );
}
