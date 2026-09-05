"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, TriangleAlert, Sparkles, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SCORE_WEIGHTS, WEIGHT_LABELS } from "@/lib/vendor-score";
import { runAction, describeError } from "@/lib/run-action";
import { ensureRubric, editCriterion, retireCriterion } from "../evaluation-actions";

export type Criterion = {
  id: string;
  dimension: keyof typeof SCORE_WEIGHTS;
  label: string;
  measure: "manual" | "auto";
  response_type: "met_partial_not_met" | "yes_no" | "scale_1_5" | null;
  sla_target_hours: number | string | null;
  max_points: number | string;
  sort_order: number;
};

const RESPONSE_LABEL: Record<string, string> = {
  met_partial_not_met: "Met / Partial / Not met",
  yes_no: "Yes / No",
  scale_1_5: "1–5 rating",
};

const EVALUATOR_LABEL: Record<keyof typeof SCORE_WEIGHTS, string> = {
  quality: "Your team, on completion",
  compliance: "Your team, on completion",
  satisfaction: "The tenant, on completion",
  response: "Measured automatically",
  completion: "Measured automatically",
};

export default function RubricEditor({ criteria }: { criteria: Criterion[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);

  if (criteria.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No rubric has been set up yet. Start from the recommended checklist —
          Quality and Compliance for your team, Satisfaction for the tenant, and
          sensible SLA targets for Response and Completion — then adjust anything
          from there.
        </p>
        <Button
          variant="brand"
          disabled={busy === "setup"}
          onClick={async () => {
            setBusy("setup");
            try {
              await runAction(ensureRubric());
              toast.success("Rubric created");
              router.refresh();
            } catch (e) {
              toast.error("Couldn't set up the rubric", { description: describeError(e) });
            } finally {
              setBusy(null);
            }
          }}
        >
          <Sparkles /> Set up the recommended rubric
        </Button>
      </div>
    );
  }

  const byDimension = new Map<string, Criterion[]>();
  for (const c of criteria) {
    if (!byDimension.has(c.dimension)) byDimension.set(c.dimension, []);
    byDimension.get(c.dimension)!.push(c);
  }

  return (
    <div className="space-y-6">
      {WEIGHT_LABELS.map(({ key, label }, i) => {
        const items = byDimension.get(key) ?? [];
        const totalPoints = items.reduce((s, c) => s + Number(c.max_points), 0);
        const isManual = items[0]?.measure === "manual";
        // Only meaningful for manual dimensions: response/completion score
        // 0–100 directly from the SLA formula, with no points to sum.
        const misweighted = isManual && items.length > 0 && Math.round(totalPoints) !== 100;

        return (
          <React.Fragment key={key}>
            {i > 0 && <Separator />}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{label}</h3>
                  <Badge variant="outline">{Math.round(SCORE_WEIGHTS[key] * 100)}% of the composite</Badge>
                  <span className="text-xs text-muted-foreground">{EVALUATOR_LABEL[key]}</span>
                </div>
                {misweighted && (
                  <span className="flex items-center gap-1 text-xs text-warning">
                    <TriangleAlert className="size-3.5" />
                    Points sum to {totalPoints}, not 100 — the checklist for this
                    dimension no longer maps directly to a 0–100 score.
                  </span>
                )}
              </div>

              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">No checklist items.</p>
              ) : (
                <div className="space-y-2">
                  {items.map((c) =>
                    editing === c.id ? (
                      <EditRow
                        key={c.id}
                        criterion={c}
                        busy={busy === c.id}
                        onCancel={() => setEditing(null)}
                        onSave={async (patch) => {
                          setBusy(c.id);
                          try {
                            await runAction(editCriterion({ id: c.id, ...patch }));
                            toast.success("Checklist item updated");
                            setEditing(null);
                            router.refresh();
                          } catch (e) {
                            toast.error("Couldn't save", { description: describeError(e) });
                          } finally {
                            setBusy(null);
                          }
                        }}
                      />
                    ) : (
                      <div
                        key={c.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm">{c.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {c.measure === "auto" ? (
                              <span className="flex items-center gap-1">
                                <Clock className="size-3" /> Target: {c.sla_target_hours} hours
                              </span>
                            ) : (
                              RESPONSE_LABEL[c.response_type ?? ""] ?? c.response_type
                            )}
                            {" · "}
                            {Number(c.max_points)} point{Number(c.max_points) === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <Button
                            size="icon-sm" variant="ghost" title="Edit"
                            onClick={() => setEditing(c.id)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm" variant="ghost" title="Remove"
                            disabled={busy === c.id}
                            onClick={async () => {
                              setBusy(c.id);
                              try {
                                await runAction(retireCriterion(c.id));
                                toast.success("Checklist item removed");
                                router.refresh();
                              } catch (e) {
                                toast.error("Couldn't remove it", { description: describeError(e) });
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}

      <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        <Plus className="mt-0.5 size-3.5 flex-shrink-0" />
        Editing an item here does not change any evaluation already submitted —
        it takes effect for jobs completed from now on, so a vendor is never
        rescored under rules that did not exist when the job was done.
      </p>
    </div>
  );
}

function EditRow({
  criterion, busy, onCancel, onSave,
}: {
  criterion: Criterion;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: { label: string; maxPoints: number; slaTargetHours?: number | null }) => void;
}) {
  const [label, setLabel] = React.useState(criterion.label);
  const [points, setPoints] = React.useState(String(criterion.max_points));
  const [sla, setSla] = React.useState(
    criterion.sla_target_hours != null ? String(criterion.sla_target_hours) : ""
  );

  return (
    <div className="space-y-2 rounded-md border border-[var(--brand)]/40 bg-muted/30 p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`label-${criterion.id}`}>Checklist item</Label>
        <Input id={`label-${criterion.id}`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`points-${criterion.id}`}>Points</Label>
          <Input
            id={`points-${criterion.id}`} type="number" min={1} value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </div>
        {criterion.measure === "auto" && (
          <div className="space-y-1.5">
            <Label htmlFor={`sla-${criterion.id}`}>SLA target (hours)</Label>
            <Input
              id={`sla-${criterion.id}`} type="number" min={0.5} step={0.5} value={sla}
              onChange={(e) => setSla(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button
          size="sm" variant="brand" disabled={busy}
          onClick={() =>
            onSave({
              label,
              maxPoints: Number(points),
              slaTargetHours: criterion.measure === "auto" ? Number(sla) : undefined,
            })
          }
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
