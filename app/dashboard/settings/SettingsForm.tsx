"use client";

import { useState, useTransition } from "react";
import { updatePaymentSettings } from "./actions";

export default function SettingsForm({
  orgId,
  initialMinScore,
  initialThreshold,
}: {
  orgId: string;
  initialMinScore: number;
  initialThreshold: number;
}) {
  const [minScore, setMinScore] = useState(String(initialMinScore));
  const [threshold, setThreshold] = useState(String(initialThreshold));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await updatePaymentSettings(orgId, Number(minScore), Number(threshold));
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  const fieldClass =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-800 focus:ring-1 focus:ring-neutral-800";

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5"
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          Minimum performance score (KPI gate)
        </label>
        <input
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
          className={fieldClass}
        />
        <p className="mt-1 text-xs text-neutral-400">
          Vendors below this composite score are blocked from remittance.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          Finance approval threshold (₦)
        </label>
        <input
          type="number"
          min={0}
          step="0.01"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          className={fieldClass}
        />
        <p className="mt-1 text-xs text-neutral-400">
          Payments above this amount require finance sign-off.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </form>
  );
}
