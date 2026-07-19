// Vendor evaluation weighting per CLAUDE.md B2 / AURA.
// Scores are on a 0–100 scale; the composite is the weighted sum (same scale).
export const SCORE_WEIGHTS = {
  quality: 0.3,
  response: 0.2,
  completion: 0.2,
  satisfaction: 0.2,
  compliance: 0.1,
} as const;

export const WEIGHT_LABELS: { key: keyof typeof SCORE_WEIGHTS; label: string }[] =
  [
    { key: "quality", label: "Quality of Work" },
    { key: "response", label: "Response Time" },
    { key: "completion", label: "Completion Time" },
    { key: "satisfaction", label: "Customer Satisfaction" },
    { key: "compliance", label: "Compliance" },
  ];

export type EvaluationScores = {
  quality: number;
  response: number;
  completion: number;
  satisfaction: number;
  compliance: number;
};

// Mirrors the generated `composite_score` column so the UI can show a live
// preview and so scores can be verified against the DB.
export function computeComposite(s: EvaluationScores): number {
  return (
    s.quality * SCORE_WEIGHTS.quality +
    s.response * SCORE_WEIGHTS.response +
    s.completion * SCORE_WEIGHTS.completion +
    s.satisfaction * SCORE_WEIGHTS.satisfaction +
    s.compliance * SCORE_WEIGHTS.compliance
  );
}

export function scoreBand(score: number): {
  label: string;
  style: string;
} {
  if (score >= 85)
    return { label: "Excellent", style: "bg-emerald-100 text-emerald-700 ring-emerald-200" };
  if (score >= 70)
    return { label: "Good", style: "bg-sky-100 text-sky-700 ring-sky-200" };
  if (score >= 55)
    return { label: "Fair", style: "bg-amber-100 text-amber-700 ring-amber-200" };
  return { label: "Needs improvement", style: "bg-red-100 text-red-700 ring-red-200" };
}

export function averageComposite(
  evaluations: { composite_score: number | string | null }[]
): number | null {
  const vals = evaluations
    .map((e) => (e.composite_score == null ? null : Number(e.composite_score)))
    .filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
