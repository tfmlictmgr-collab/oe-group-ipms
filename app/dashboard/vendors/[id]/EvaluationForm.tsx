"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

function bandVariant(score: number) {
  if (score >= 85) return "success" as const;
  if (score >= 70) return "info" as const;
  if (score >= 55) return "warning" as const;
  return "destructive" as const;
}

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
  const [loading, setLoading] = useState(false);

  const composite = computeComposite(scores);
  const band = scoreBand(composite);

  function setScore(key: keyof EvaluationScores, value: number) {
    setScores((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

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
      toast.error("Could not save evaluation", { description: error.message });
      setLoading(false);
      return;
    }

    toast.success("Evaluation submitted", {
      description: `Composite score ${composite.toFixed(1)} — ${band.label}.`,
    });
    router.refresh();
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {WEIGHT_LABELS.map((w) => (
          <div key={w.key} className="space-y-1.5">
            <Label htmlFor={`score-${w.key}`}>
              {w.label}{" "}
              <span className="font-normal text-muted-foreground">
                ({Math.round(SCORE_WEIGHTS[w.key] * 100)}%)
              </span>
            </Label>
            <Input
              id={`score-${w.key}`}
              type="number"
              min={0}
              max={100}
              required
              value={scores[w.key]}
              onChange={(e) => setScore(w.key, Number(e.target.value))}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="period">
            Period <span className="font-normal text-muted-foreground">(e.g. 2026-07)</span>
          </Label>
          <Input
            id="period"
            type="text"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-07"
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md bg-muted/60 px-4 py-3">
        <span className="text-sm text-muted-foreground">Composite (live preview)</span>
        <div className="flex items-center gap-2">
          <Badge variant={bandVariant(composite)}>{band.label}</Badge>
          <span className="text-xl font-semibold tabular-nums">
            {composite.toFixed(1)}
          </span>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" variant="brand" disabled={loading}>
          {loading ? "Saving…" : "Submit Evaluation"}
        </Button>
      </div>
    </form>
  );
}
