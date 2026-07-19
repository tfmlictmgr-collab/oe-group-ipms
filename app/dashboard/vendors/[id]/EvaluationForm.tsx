"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  WEIGHT_LABELS,
  SCORE_WEIGHTS,
  computeComposite,
  scoreBand,
  type EvaluationScores,
} from "@/lib/vendor-score";

const COLUMN: Record<keyof EvaluationScores, string> = {
  quality: "quality_score",
  response: "response_score",
  completion: "completion_score",
  satisfaction: "satisfaction_score",
  compliance: "compliance_score",
};

export default function EvaluationForm({
  vendorId,
  orgId,
}: {
  vendorId: string;
  orgId: string;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<EvaluationScores>({
    quality: 80,
    response: 80,
    completion: 80,
    satisfaction: 80,
    compliance: 80,
  });
  const [period, setPeriod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const composite = computeComposite(scores);
  const band = scoreBand(composite);

  function setScore(key: keyof EvaluationScores, value: number) {
    setScores((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const row: Record<string, unknown> = {
      org_id: orgId,
      vendor_id: vendorId,
      evaluated_by: user?.id ?? null,
      period: period || null,
    };
    for (const key of Object.keys(COLUMN) as (keyof EvaluationScores)[]) {
      row[COLUMN[key]] = scores[key];
    }

    const { error } = await supabase.from("vendor_evaluations").insert(row);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.refresh();
    setLoading(false);
  }

  const fieldClass =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-800 focus:ring-1 focus:ring-neutral-800";

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-black/5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {WEIGHT_LABELS.map((w) => (
          <div key={w.key}>
            <label className="mb-1 block text-sm font-medium text-neutral-700">
              {w.label}{" "}
              <span className="font-normal text-neutral-400">
                ({Math.round(SCORE_WEIGHTS[w.key] * 100)}%)
              </span>
            </label>
            <input
              type="number"
              min={0}
              max={100}
              required
              value={scores[w.key]}
              onChange={(e) => setScore(w.key, Number(e.target.value))}
              className={fieldClass}
            />
          </div>
        ))}
        <div>
          <label className="mb-1 block text-sm font-medium text-neutral-700">
            Period{" "}
            <span className="font-normal text-neutral-400">(e.g. 2026-07)</span>
          </label>
          <input
            type="text"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className={fieldClass}
            placeholder="2026-07"
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-neutral-50 px-4 py-3">
        <span className="text-sm text-neutral-500">Composite (live preview)</span>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${band.style}`}
          >
            {band.label}
          </span>
          <span className="text-xl font-bold tabular-nums text-neutral-800">
            {composite.toFixed(1)}
          </span>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Saving…" : "Submit Evaluation"}
        </button>
      </div>
    </form>
  );
}
