"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Star, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import { submitEvaluation } from "./evaluation-actions";

export type ChecklistCriterion = {
  id: string;
  label: string;
  response_type: "met_partial_not_met" | "yes_no" | "scale_1_5";
  max_points: number | string;
};

// Mirrors the server's own value→fraction mapping (0104) exactly, so the
// live point preview shown while answering never disagrees with what actually
// gets recorded once submitted.
const FRACTION: Record<string, Record<string, number>> = {
  met_partial_not_met: { met: 1, partial: 0.5, not_met: 0 },
  yes_no: { yes: 1, no: 0 },
  scale_1_5: { "1": 0, "2": 0.25, "3": 0.5, "4": 0.75, "5": 1 },
};

function Options({
  type, value, onChange,
}: {
  type: ChecklistCriterion["response_type"];
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  if (type === "met_partial_not_met") {
    return (
      <div className="flex gap-1.5">
        {[["met", "Met"], ["partial", "Partial"], ["not_met", "Not met"]].map(([v, l]) => (
          <button
            key={v} type="button" onClick={() => onChange(v)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              value === v
                ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
                : "border-input text-muted-foreground hover:bg-accent"
            )}
          >
            {l}
          </button>
        ))}
      </div>
    );
  }
  if (type === "yes_no") {
    return (
      <div className="flex gap-1.5">
        {[["yes", "Yes"], ["no", "No"]].map(([v, l]) => (
          <button
            key={v} type="button" onClick={() => onChange(v)}
            className={cn(
              "rounded-md border px-4 py-1.5 text-xs font-medium transition-colors",
              value === v
                ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]"
                : "border-input text-muted-foreground hover:bg-accent"
            )}
          >
            {l}
          </button>
        ))}
      </div>
    );
  }
  // scale_1_5 — stars, the natural widget for "how satisfied were you".
  return (
    <div className="flex gap-1">
      {["1", "2", "3", "4", "5"].map((v) => (
        <button
          key={v} type="button" onClick={() => onChange(v)} aria-label={`${v} stars`}
          className="p-0.5"
        >
          <Star
            className={cn(
              "size-6 transition-colors",
              value && Number(v) <= Number(value)
                ? "fill-warning text-warning"
                : "text-muted-foreground/40"
            )}
          />
        </button>
      ))}
    </div>
  );
}

export default function EvaluationChecklist({
  ticketId, source, criteria, title, description,
}: {
  ticketId: string;
  source: "tenant" | "fm_pm";
  criteria: ChecklistCriterion[];
  title: string;
  description: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const totalPoints = criteria.reduce((s, c) => s + Number(c.max_points), 0);
  const earnedPreview = criteria.reduce((s, c) => {
    const v = answers[c.id];
    if (!v) return s;
    return s + Number(c.max_points) * (FRACTION[c.response_type]?.[v] ?? 0);
  }, 0);
  const complete = criteria.every((c) => answers[c.id] !== undefined);

  async function submit() {
    setBusy(true);
    try {
      await runAction(
        submitEvaluation(
          ticketId, source,
          criteria.map((c) => ({ criterionId: c.id, value: answers[c.id] }))
        )
      );
      setDone(true);
      toast.success("Thank you — your review has been recorded.");
      router.refresh();
    } catch (e) {
      toast.error("Couldn't submit that", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/8 px-4 py-3 text-sm text-success">
        <CheckCircle2 className="size-4" /> Submitted. Thank you.
      </div>
    );
  }

  if (criteria.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No checklist has been set up for this yet — ask an administrator to
        configure the evaluation rubric under Settings.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="space-y-3">
        {criteria.map((c) => (
          <div key={c.id} className="space-y-1.5 rounded-md border border-border p-3">
            <p className="text-sm font-medium">{c.label}</p>
            <Options
              type={c.response_type}
              value={answers[c.id]}
              onChange={(v) => setAnswers((a) => ({ ...a, [c.id]: v }))}
            />
          </div>
        ))}
      </div>

      {totalPoints > 0 && (
        <div className="flex items-center justify-between rounded-md bg-muted/60 px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">Preview</span>
          <span className="font-semibold tabular-nums">
            {complete ? `${earnedPreview.toFixed(0)} / ${totalPoints}` : "Answer every item to see a total"}
          </span>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="brand" disabled={!complete || busy} onClick={submit}>
          {busy ? "Submitting…" : `Submit ${title.toLowerCase()}`}
        </Button>
      </div>
    </div>
  );
}
