"use client";

import { useState, useTransition } from "react";
import { acknowledgeJob } from "./actions";

export default function AcknowledgeControl({ ticketId }: { ticketId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await acknowledgeJob(ticketId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to acknowledge");
      }
    });
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <h3 className="text-sm font-semibold text-amber-800">
        This job has been assigned to you
      </h3>
      <p className="mt-1 text-sm text-amber-700">
        Acknowledge to confirm you have received it.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-lg btn-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Acknowledging…" : "Acknowledge job"}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
