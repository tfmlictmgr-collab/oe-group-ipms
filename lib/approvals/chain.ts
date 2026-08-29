// The tiered, multi-stage approval chain — read side and labels.
//
// Companion to 0151/0152. This layer exists for GOOD ERROR MESSAGES and for
// scoping the queue; it is deliberately NOT the control. Every rule it states
// is enforced again by `enforce_approval_rules()` on the way into
// `payment_approvals`, and the amount it displays is re-resolved from the
// payable by that trigger regardless of what is passed here. Deleting this file
// would make the product worse and the system no less safe; deleting the
// trigger would do the opposite.
//
// ⚠️ The amount is never a parameter. It is read from the payable record, both
// here and in the database. A client-supplied amount that selects a lower tier
// is the attack on a tiered ladder, and neither layer offers a way to do it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { FM_PM } from "@/lib/roles";

export type PayableType = "vendor_payment" | "landlord_payout" | "ops_requisition";
export type ApprovalTier = 1 | 2 | 3;
export type Decision = "approved" | "rejected";

/**
 * Which ladder an organisation climbs. Mirrors `org_payment_chain()` (0211).
 *
 * OEA runs the four-hand flow the board set on 28 Aug 2026 (decision 23):
 * audit → Managing Partner → payment approver, then the payment officer
 * disburses. Everyone else keeps the standard ladder, where the FM/PM sign-off
 * is the first rung rather than the precondition.
 */
export type ChainShape = "standard" | "oea";

/**
 * Mirrors `payment_chain_stages(org_id)`. Hardwired there, hardwired here.
 *
 * ⚠️ Both shapes are THREE stages, exactly as the database has them — the
 * stage_order check, the one-live-row-per-stage index and every "% of 3
 * stages" message depend on that and none of them had to be re-reasoned.
 */
export const CHAIN_SHAPES = {
  standard: [
    {
      stageOrder: 1 as const,
      requiredRoles: [...FM_PM, "regional_manager"],
      tierResolved: false,
      // ⚠️ NOT an approval (board, 22 Aug 2026). An FM/PM confirms the work was
      // DONE — they have been to the building and the job card matches. They
      // hold no spending limit and no tier. The approval tiers are stages 2 and
      // 3; calling this one an approval made "Requires Tier 2" appear above a
      // stage no tier applies to.
      label: "Work completed and signed off",
      short: "Work signed off",
      verb: "Sign off",
    },
    {
      stageOrder: 2 as const,
      requiredRoles: ["payment_audit_approver"],
      tierResolved: false,
      label: "Audit verification",
      short: "Audit check",
      verb: "Review",
    },
    {
      stageOrder: 3 as const,
      requiredRoles: ["payment_approver", "executive"],
      tierResolved: true,
      label: "Final approval",
      short: "Final approval",
      verb: "Approve",
    },
  ],
  oea: [
    {
      stageOrder: 1 as const,
      requiredRoles: ["payment_audit_approver"],
      tierResolved: false,
      // The FM/PM sign-off is not here, and that is decision 23: it is the
      // PRECONDITION that commences the chain, not a rung of it.
      //
      // ⚠️ "and RECOMMENDATION", not "and approval" (board, 29 Aug 2026). The
      // auditor checks the invoice against the job card and the evidence and
      // says whether it stands up; the money is authorised by the MP and the
      // payment approver behind them. Calling it an approval put a fourth
      // approver in a three-approver chain, in the reader's head if nowhere
      // else — the same correction 0189 made to the FM/PM sign-off.
      label: "Audit review and recommendation",
      short: "Audit review",
      verb: "Review",
    },
    {
      stageOrder: 2 as const,
      requiredRoles: ["executive"],
      tierResolved: false,
      label: "Managing Partner approval",
      short: "MP approval",
      verb: "Approve",
    },
    {
      stageOrder: 3 as const,
      requiredRoles: ["payment_approver"],
      tierResolved: true,
      label: "Payment approval",
      short: "Payment approval",
      verb: "Approve",
    },
  ],
} as const;

export type StageOrder = 1 | 2 | 3;

export function chainStagesFor(
  shape: ChainShape
): (typeof CHAIN_SHAPES)[ChainShape] {
  return CHAIN_SHAPES[shape] ?? CHAIN_SHAPES.standard;
}

/**
 * Every role that appears at any stage of any ladder, plus the payment officer,
 * who holds no stage but releases what the chain clears (decision 16).
 *
 * Read from `CHAIN_SHAPES` rather than retyped, so a role added to a stage
 * reaches this automatically. The UNION of both shapes deliberately: this
 * decides whether someone is shown the pipeline at all, and a person's own org
 * shape is the wrong question — an executive is in the chain on both.
 */
export const ALL_CHAIN_ROLES: ReadonlySet<string> = new Set<string>([
  ...Object.values(CHAIN_SHAPES).flatMap((stages) =>
    stages.flatMap((s) => s.requiredRoles as readonly string[])
  ),
  "finance_approver",
]);

export interface StageState {
  stageOrder: StageOrder;
  label: string;
  short: string;
  requiredRoles: readonly string[];
  tierResolved: boolean;
  /** What this actor DOES — "Review" for the audit stage, "Approve" for the
   *  ones that authorise money, "Sign off" for the FM/PM work check. The button
   *  says the act, not a generic verb for all three. */
  verb: string;
  decision: Decision | null;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Only set on the tier-resolved stage. */
  requiredTier: ApprovalTier | null;
  /** The amount this stage was decided at — not necessarily the current one. */
  decidedAmount: number | null;
  /**
   * A decision that exists but no longer counts, because it was given at a
   * different amount. `decision` is null in that case: the stage is actionable
   * again, and this says why it looks decided in the trail.
   */
  staleDecision: Decision | null;
}

export interface ChainState {
  orgId: string | null;
  /** Which ladder this payable's organisation climbs (decision 23). */
  shape: ChainShape;
  payableType: PayableType;
  payableId: string;
  /** Server-resolved from the payable record. */
  amount: number;
  requiredTier: ApprovalTier;
  stages: StageState[];
  nextStage: StageState | null;
  rejected: boolean;
  rejectedReason: string | null;
  clearedForDisbursement: boolean;
  /** Approved at every stage, but at a different amount than the current one. */
  amountChangedAfterApproval: boolean;
}

/**
 * The amount band a person may clear at the tier-resolved stage.
 *
 * Mirrors `effective_approval_tier()`. `executive` is tier 3 by decision 9
 * ("co-holds payment approval, including above the threshold"); everyone else
 * carries no limit and cannot action that stage at all.
 *
 * ⚠️ `admin` is DELIBERATELY ABSENT. It returned 2 here under decision 16 ("an
 * administrator approves within the threshold"); decision 23 removed the
 * administrator from money approval altogether, on both ladders. They still
 * administer the organisation — they no longer approve spending against a
 * limit. Kept in step with 0211's `effective_approval_tier()`.
 */
export function effectiveTier(
  role: string,
  approvalTier: number | null
): ApprovalTier | null {
  if (role === "payment_approver") {
    return approvalTier === 1 || approvalTier === 2 || approvalTier === 3
      ? approvalTier
      : null;
  }
  if (role === "executive") return 3;
  return null;
}

/**
 * A higher tier may always approve a lower amount — `>=`, never equality.
 * Otherwise a ₦50,000 payment is unapprovable whenever only the MD is in,
 * which is the opposite of what a ladder is for.
 */
export function tierSatisfies(
  actorTier: ApprovalTier | null,
  requiredTier: ApprovalTier
): boolean {
  return actorTier !== null && actorTier >= requiredTier;
}

export interface Actor {
  id: string;
  role: string;
  approvalTier: number | null;
}

/**
 * Whether this person can action this payable RIGHT NOW. Used to scope the
 * queue, so a tier-1 approver sees what they can act on rather than a list of
 * rows that will refuse them.
 */
export function canActorAction(actor: Actor, state: ChainState): boolean {
  if (state.rejected || !state.nextStage) return false;
  const stage = state.nextStage;
  if (!stage.requiredRoles.includes(actor.role)) return false;
  // One human, one stage — holding two roles does not make you two people.
  if (state.stages.some((s) => s.actorId === actor.id)) return false;
  if (stage.tierResolved) {
    return tierSatisfies(
      effectiveTier(actor.role, actor.approvalTier),
      state.requiredTier
    );
  }
  return true;
}

/**
 * Why this person cannot action it — for a tooltip, never for a decision.
 * Returns null when they can.
 */
export function whyNotActionable(
  actor: Actor,
  state: ChainState
): string | null {
  if (state.rejected) return "This payment was rejected.";
  if (!state.nextStage) return "Every stage is already approved.";
  const stage = state.nextStage;
  if (state.stages.some((s) => s.actorId === actor.id)) {
    return "You actioned an earlier stage — this needs a second pair of hands.";
  }
  if (!stage.requiredRoles.includes(actor.role)) {
    return `Waiting on ${stage.label.toLowerCase()}.`;
  }
  if (stage.tierResolved) {
    const mine = effectiveTier(actor.role, actor.approvalTier);
    if (!tierSatisfies(mine, state.requiredTier)) {
      return `${formatNaira(state.amount)} needs a tier ${state.requiredTier} approver or above.`;
    }
  }
  return null;
}

/**
 * Whose desk this payable is sitting on, in words.
 *
 * ⚠️ Reported from the demo: a payment approver opened a requisition that was
 * genuinely waiting for them, found no button, and had no way to learn why. The
 * refusal was correct — ₦200,000 needs a tier-2 approver and they hold tier 1 —
 * but a queue that shows a decision and withholds the reason teaches people the
 * product is broken rather than that they are the wrong pair of hands.
 *
 * `whyNotActionable` already answers "why not ME". This answers the question
 * before it: "then who?".
 */
export function waitingOn(state: ChainState): string {
  if (state.rejected) return "Rejected — it goes no further.";
  if (!state.nextStage) {
    return "Every approval stage is complete. It is with the payment officer to release.";
  }
  const stage = state.nextStage;
  const who = stage.requiredRoles.map((r) => ROLE_WORDS[r] ?? r).join(" or ");
  if (stage.tierResolved) {
    return `Waiting on a ${who} at ${tierLabel(state.requiredTier).toLowerCase()} — ${formatNaira(state.amount)} needs that band or above.`;
  }
  return `Waiting on the ${who}.`;
}

/** Role names as a person would say them, not as the enum spells them. */
const ROLE_WORDS: Record<string, string> = {
  payment_audit_approver: "payment auditor",
  executive: "Managing Partner",
  payment_approver: "payment approver",
  finance_approver: "payment officer",
  facility_manager: "facilities manager",
  property_manager: "properties manager",
  regional_manager: "regional manager",
};

export function formatNaira(amount: number): string {
  return `₦${Number(amount).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function tierLabel(tier: ApprovalTier): string {
  return tier === 3 ? "Tier 3 (unlimited)" : `Tier ${tier}`;
}

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

interface ApprovalRow {
  stage_order: number;
  decision: Decision;
  actor_id: string;
  actor_role: string;
  amount: string | number;
  required_tier: number | null;
  reason: string | null;
  created_at: string;
  superseded_at: string | null;
  users?: { full_name: string | null } | null;
}

/**
 * The whole state of one payable's chain.
 *
 * `amount` is read from the payable, never passed in — so what the UI shows and
 * what the tier comparison uses are the same number by construction.
 */
export async function getChainState(
  supabase: SupabaseClient,
  payableType: PayableType,
  payableId: string
): Promise<ChainState> {
  const [{ data: payable }, { data: rows }] = await Promise.all([
    supabase
      .rpc("resolve_payable", { p_type: payableType, p_id: payableId })
      .maybeSingle(),
    supabase
      .from("payment_approvals")
      .select(
        "stage_order, decision, actor_id, actor_role, amount, required_tier, reason, created_at, superseded_at, users:actor_id(full_name)"
      )
      .eq("payable_type", payableType)
      .eq("payable_id", payableId)
      // Superseded rows are the record of a PREVIOUS round at a previous amount
      // (0175). They stay in the table because an approval that can vanish is
      // not evidence of anything, and they are excluded here because they
      // authorise nothing.
      .is("superseded_at", null)
      .order("stage_order"),
  ]);

  const p = payable as { org_id: string; amount: string | number } | null;
  const amount = Number(p?.amount ?? 0);
  const orgId = p?.org_id ?? null;

  const approvals = (rows ?? []) as unknown as ApprovalRow[];
  const byStage = new Map(approvals.map((a) => [a.stage_order, a]));

  // Both in one round trip. The shape decides which ladder is rendered, so it
  // is resolved from the SAME org the amount was, rather than from the viewer's
  // own organisation — a payable is approved on its own org's chain and the
  // reader may be an operator looking at someone else's.
  const [{ data: tier }, { data: shapeRow }] = await Promise.all([
    supabase.rpc("resolve_required_tier", { p_org_id: orgId, p_amount: amount }),
    supabase.rpc("org_payment_chain", { p_org_id: orgId }),
  ]);
  const requiredTier = (Number(tier) || 1) as ApprovalTier;
  const shape: ChainShape = shapeRow === "oea" ? "oea" : "standard";
  const stageSpec = chainStagesFor(shape);

  /**
   * ⚠️ An approval only COUNTS at the amount it was given for.
   *
   * This is what makes an amount change recoverable rather than terminal. The
   * chain gate has always required every stage approved at the current amount
   * (`is_cleared_for_disbursement`), but this read path used to treat any row as
   * a decision — so after an upward edit every stage still looked decided,
   * `nextStage` was null, `StageActions` rendered nowhere, and the payment sat
   * telling the reader it had to be approved again with nothing anywhere able to
   * do it. Treating a stale approval as no decision puts stage 1 back in front
   * of the person who has to re-sign it.
   *
   * A REJECTION is deliberately not amount-scoped. A refusal is terminal, and
   * scoping it to the amount would let anyone clear one by nudging the figure.
   */
  const counts = (a: ApprovalRow | undefined): boolean =>
    Boolean(a) && (a!.decision === "rejected" || Number(a!.amount) === amount);

  const stages: StageState[] = stageSpec.map((s) => {
    const a = byStage.get(s.stageOrder);
    const live = counts(a);
    return {
      stageOrder: s.stageOrder,
      label: s.label,
      short: s.short,
      requiredRoles: s.requiredRoles,
      tierResolved: s.tierResolved,
      verb: s.verb,
      decision: live ? (a!.decision ?? null) : null,
      // The actor and the trail are kept even for a stale row: who signed the
      // old figure off, and at what, is the whole explanation of why this is
      // back at stage 1.
      actorId: a?.actor_id ?? null,
      actorName: a?.users?.full_name ?? null,
      actorRole: a?.actor_role ?? null,
      decidedAt: a?.created_at ?? null,
      reason: a?.reason ?? null,
      requiredTier: s.tierResolved ? requiredTier : null,
      decidedAmount: a ? Number(a.amount) : null,
      staleDecision: a && !live ? a.decision : null,
    };
  });

  const rejectedRow = approvals.find((a) => a.decision === "rejected");
  const rejected = Boolean(rejectedRow);

  const allApproved = stages.every((s) => s.decision === "approved");
  // Cleared only if every stage was approved AT THE CURRENT AMOUNT — which
  // `decision` now already encodes, since a stale row does not count as one.
  const clearedForDisbursement = !rejected && allApproved;

  return {
    orgId,
    shape,
    payableType,
    payableId,
    amount,
    requiredTier,
    stages,
    nextStage: rejected
      ? null
      : (stages.find((s) => s.decision === null) ?? null),
    rejected,
    rejectedReason: rejectedRow?.reason ?? null,
    clearedForDisbursement,
    amountChangedAfterApproval: !rejected && stages.some((s) => s.staleDecision !== null),
  };
}
