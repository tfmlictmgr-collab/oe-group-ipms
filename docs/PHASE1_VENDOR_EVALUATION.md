# Phase 1 Spec — KPI/SLA-Driven, Dual-Source Vendor Evaluation

**Status:** Phase 1 feature request (2026-07-22). Enhances Module 2 (Vendor
Management & Evaluation). Recorded so it is scheduled, not assumed.

## The ask (restated)

1. On **job completion**, the **tenant** who raised the request reviews the vendor,
   using the same grading system.
2. The tenant's review **combines** with the **FM/PM** evaluation to make up the
   vendor's overall evaluation score (not FM-only, as today).
3. Scores must **not be arbitrary** — evaluators answer an agreed **KPI/SLA
   checklist** with allotted points per line item; the score is *computed* from the
   responses, not free-typed.
4. The KPI/SLA checklists (one for FM/PM, one for tenant) are **editable in-app by
   an authorised person** (admin).

> **One point to confirm:** the ask says "tenant and vendor" — we read this as
> **tenant + FM/PM** (the two evaluators), since the vendor is the subject. Flagged
> for confirmation.

## Key design decisions (recommended)

**A. Map the two sources onto the AURA weights we already have.** The AURA model is
Quality 30 · Response 20 · Completion 20 · **Customer Satisfaction 20** · Compliance 10.
"Customer Satisfaction" *is* the tenant's voice. So:
- **Tenant** fills the **Customer Satisfaction** checklist (on completion).
- **FM/PM** fills **Quality / Response / Completion / Compliance**.
- The composite combines them exactly as the existing weights specify — no
  arbitrary "blend %" to argue about. This is cleaner than averaging two full
  scores and it's already the intended meaning of the weighting.

**B. Auto-measure the objective KPIs; checklist only the subjective ones.** We
already capture `created_at`, `assigned_at`, `acknowledged_at` (and can add
`completed_at`). So **Response Time** and **Completion Time** can be measured
*automatically* against the SLA target (e.g. "acknowledged ≤ 4h") — zero human
input, zero arbitrariness. The checklist then covers Quality, Compliance
(FM/PM) and Satisfaction (tenant). Strongest anti-arbitrary design.

## Data model (new/changed)

- `evaluation_criteria` (admin-editable rubric): `org_id`, `dimension`
  (quality|response|completion|satisfaction|compliance), `evaluator`
  (tenant|fm_pm), `label` (the KPI/SLA statement), `sla_target` (e.g. "≤ 4 hours"),
  `max_points`, `response_type` (met/partial/not_met | yes_no | 1–5), `measure`
  (manual | auto_response_time | auto_completion_time), `active`, `sort_order`,
  `effective_from`. **Versioned/effective-dated** so vendors aren't retroactively
  re-scored under changed criteria.
- `vendor_evaluations` (extend): add `source` (tenant|fm_pm), `ticket_id` (the
  completed job), `evaluated_by`. Composite becomes *computed*.
- `evaluation_responses`: `evaluation_id`, `criterion_id`, `response_value`,
  `points_awarded`. Dimension score = Σ points_awarded ÷ Σ max_points × 100 →
  fed into the AURA weights.
- RLS: admin writes criteria; FM/admin submit FM evaluations; the **assigned job's
  tenant** submits the satisfaction review (scoped to their own completed ticket).

## Flow

1. Admin defines/edits the KPI/SLA checklists in a **rubric editor** (in-app).
2. FM dispatches → vendor completes → status `completed` (new step after
   `acknowledged`), stamping `completed_at`.
3. On completion: FM gets the operational checklist; the **tenant is prompted**
   (in-portal + B8 cascade) to complete the satisfaction checklist.
4. App computes each dimension from responses (+ auto-measures response/completion
   vs SLA), applies AURA weights → the vendor's evaluation for that job/period.
5. Everything audited (Module 5 triggers already exist).

## Replaces / touches

- The current `EvaluationForm` (5 free 0–100 inputs) → **checklist-driven** form.
- Vendor scorecard shows source breakdown (tenant vs FM/PM) and per-criterion detail.
- Ties into dispatch (needs a `completed` status + `completed_at`).

## Effort & sequencing (within Phase 1's ~8–10 weeks)

Estimated **~1.5–2 weeks** for this feature, sequenced as:
1. Rubric schema + admin rubric editor (foundational — do early).
2. Add `completed` job status + `completed_at` to dispatch.
3. Refactor FM evaluation to checklist-driven + auto-KPI measurement.
4. Tenant satisfaction review on completion (+ cascade prompt).
5. Compose sources into the AURA composite; scorecard UI; tests.

Depends on: dispatch/assignment (✅ built in POC), notification cascade (✅ built),
audit (✅ built) — so the seams already exist.
