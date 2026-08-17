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

export type PayableType = "vendor_payment" | "landlord_payout" | "ops_requisition";
export type ApprovalTier = 1 | 2 | 3;
export type Decision = "approved" | "rejected";

/** Mirrors `payment_chain_stages()`. Hardwired there, hardwired here. */
export const CHAIN_STAGES = [
  {
    stageOrder: 1 as const,
    requiredRoles: ["facility_manager", "regional_manager"],
    tierResolved: false,
    label: "Job sign-off and approval for payment",
    short: "Job sign-off",
  },
  {
    stageOrder: 2 as const,
    requiredRoles: ["payment_audit_approver"],
    tierResolved: false,
    label: "Audit verification",
    short: "Audit check",
  },
  {
    stageOrder: 3 as const,
    requiredRoles: ["payment_approver", "executive", "admin"],
    tierResolved: true,
    label: "Final approval",
    short: "Final approval",
  },
] as const;

export type StageOrder = (typeof CHAIN_STAGES)[number]["stageOrder"];

export interface StageState {
  stageOrder: StageOrder;
  label: string;
  short: string;
  requiredRoles: readonly string[];
  tierResolved: boolean;
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
 * The amount band a person may clear at stage 3.
 *
 * Mirrors `effective_approval_tier()`. `executive` is tier 3 by decision 9
 * ("co-holds payment approval, including above the threshold"); `admin` is
 * tier 2 by decision 16 ("an administrator approves within the threshold");
 * everyone else carries no limit and cannot action stage 3 at all.
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
  if (role === "admin") return 2;
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

  const { data: tier } = await supabase.rpc("resolve_required_tier", {
    p_org_id: orgId,
    p_amount: amount,
  });
  const requiredTier = (Number(tier) || 1) as ApprovalTier;

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

  const stages: StageState[] = CHAIN_STAGES.map((s) => {
    const a = byStage.get(s.stageOrder);
    const live = counts(a);
    return {
      stageOrder: s.stageOrder,
      label: s.label,
      short: s.short,
      requiredRoles: s.requiredRoles,
      tierResolved: s.tierResolved,
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
