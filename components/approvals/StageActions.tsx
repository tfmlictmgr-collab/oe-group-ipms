"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, X, MessageSquarePlus, CornerUpLeft, PencilLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatNaira } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { recordStageDecision } from "@/lib/approvals/actions";
import type { PayableType, StageOrder } from "@/lib/approvals/chain";

/**
 * Approve or refuse one stage.
 *
 * The amount is deliberately absent from everything this component sends. It is
 * displayed by the parent for the person's benefit and resolved server-side for
 * the decision's — a form field carrying the amount is precisely the tier-ladder
 * attack, and there is no such field here to tamper with.
 */
export default function StageActions({
  payableType,
  payableId,
  stage,
  stageLabel,
  verb = "Approve",
  returnsTo,
  amount,
}: {
  payableType: PayableType;
  payableId: string;
  stage: StageOrder;
  stageLabel: string;
  /**
   * What this actor actually does. The audit stage is a REVIEW AND
   * RECOMMENDATION (board, 29 Aug 2026) — the money is authorised by the MP and
   * the payment approver behind it — so a button reading "Approve" there put a
   * fourth approver in a three-approver chain in the reader's head.
   */
  verb?: string;
  /**
   * Where a "send back" goes from here — "the desk below" for stage 2 and up,
   * "whoever raised it" for stage 1. Passed in rather than derived, because
   * this component knows its stage number and not which ladder it is on, and
   * on `single_stage` (0248) stage 1 is the only rung there is.
   */
  returnsTo?: string;
  /**
   * What the payable currently says. Shown, and used to prefill the revision
   * field — NOT sent as the decision's amount. `record_payment_approval` reads
   * the figure from the payable itself, and only a DELIBERATE revision typed by
   * this approver is ever transmitted.
   */
  amount?: number | null;
}) {
  const [busy, setBusy] = React.useState<"approve" | "reject" | "return" | null>(null);
  const [refusing, setRefusing] = React.useState(false);
  const [returning, setReturning] = React.useState(false);
  const [reason, setReason] = React.useState("");
  /**
   * An optional note carried with a POSITIVE decision.
   *
   * `record_payment_approval` has always accepted `p_reason` on an approval and
   * required it only on a refusal — the column was there and no screen ever
   * offered it, so every approval in the trail said nothing but who and when.
   * The auditor in particular has a recommendation to make, not merely a verdict
   * to register.
   */
  const [note, setNote] = React.useState("");
  const [noting, setNoting] = React.useState(false);
  /**
   * A revised figure (0270). Reported from the live portal: three desks wrote
   * "MP approve 150,000" into the comment box while the payable went on saying
   * ₦166,000, and the payment officer was left reconciling prose against a
   * number. This is the field that was missing.
   */
  const [revising, setRevising] = React.useState(false);
  const [amountText, setAmountText] = React.useState("");

  async function submit(
    decision: "approved" | "rejected" | "returned",
    revisedAmount?: number | null
  ) {
    setBusy(
      decision === "approved" ? "approve" : decision === "rejected" ? "reject" : "return"
    );
    const res = await recordStageDecision({
      payableType,
      payableId,
      stage,
      decision,
      approvedAmount: revisedAmount ?? null,
      // A refusal must say why and a return must say what to correct; an
      // approval may. All three land in the same column and all three show on
      // the trail.
      reason:
        decision === "approved"
          ? // A revision's justification is required and lives in the same box
            // a return's does, because that is what the database records it as.
            (revisedAmount ? reason : note.trim() || null)
          : reason,
    });
    setBusy(null);

    if (!res.ok) {
      toast.error(res.message, { description: res.hint ?? undefined });
      return;
    }
    // ⚠️ The revision toast must not say "approved". The database records it as
    // a RETURN and every desk below has to sign the new figure — telling
    // somebody their ₦150,000 is approved when it has just gone back to stage 1
    // is the same fault as writing the number in a comment box.
    toast.success(
      revisedAmount
        ? `Sent back at ${formatNaira(revisedAmount)}.`
        : decision === "approved"
          ? `${stageLabel} approved.`
          : decision === "returned"
            ? "Sent back for correction."
            : "Payment refused.",
      revisedAmount
        ? {
            description:
              "Changing the amount voids every approval already given — they were given for a different figure. The chain re-climbs from the first stage at the new one.",
          }
        : undefined
    );
    setRefusing(false);
    setReturning(false);
    setRevising(false);
    setAmountText("");
    setReason("");
    setNote("");
    setNoting(false);
  }

  if (refusing) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={`reason-${stage}`}>Why are you refusing this?</Label>
          <textarea
            id={`reason-${stage}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. The invoice total does not match the signed job card."
          />
          <p className="text-xs text-muted-foreground">
            They have to be able to act on this — at least 10 characters.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={busy !== null || reason.trim().length < 10}
            onClick={() => submit("rejected")}
          >
            {busy === "reject" ? "Refusing…" : "Confirm refusal"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setRefusing(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Deliberately a separate panel from the refusal, in a different colour, with
  // different words. They are different acts: one ends the payable, the other
  // asks for a correction and expects it back. Collapsing them into one button
  // with a dropdown is how somebody kills a requisition they meant to query.
  if (returning) {
    return (
      <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
        <div className="space-y-1.5">
          <Label htmlFor={`return-${stage}`}>What needs correcting?</Label>
          <textarea
            id={`return-${stage}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. The generator line is billed at 4 hours; the job card says 2. Please correct and resend."
          />
          <p className="text-xs text-muted-foreground">
            This goes back to {returnsTo ?? "the desk below you"} and they can
            only act on what you tell them — at least 10 characters. Nothing is
            refused: the request stays alive and comes back to you once it is
            corrected.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy !== null || reason.trim().length < 10}
            onClick={() => submit("returned")}
          >
            {busy === "return" ? "Sending back…" : "Send back for correction"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setReturning(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // A revision is its own panel, in its own colour, like the refusal and the
  // return beside it. It is not a variant of Approve: it changes what is being
  // authorised, and the person doing it should be in no doubt that the ladder
  // starts again.
  if (revising) {
    const parsed = Number(amountText.replace(/[^\d.]/g, ""));
    const valid = Number.isFinite(parsed) && parsed > 0;
    const unchanged = valid && amount != null && Number(amount) === parsed;
    return (
      <div className="space-y-3 rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-900/50 dark:bg-sky-950/30">
        <div className="space-y-1.5">
          <Label htmlFor={`amount-${stage}`}>What amount are you approving?</Label>
          {amount != null && (
            <p className="text-xs text-muted-foreground">
              Currently {formatNaira(amount)}.
            </p>
          )}
          <Input
            id={`amount-${stage}`}
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder={amount != null ? String(amount) : "150000"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`revreason-${stage}`}>Why is it changing?</Label>
          <textarea
            id={`revreason-${stage}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. Transport is not chargeable on this contract — approving materials and labour only."
          />
        </div>
        <p className="text-xs text-muted-foreground">
          ⚠️ Changing the amount <strong>voids every approval already given</strong> —
          they were given for a different figure — and the request climbs the
          chain again from the first stage at the new one. The payment officer
          pays what the chain finally approves and cannot edit it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy !== null || !valid || unchanged || reason.trim().length < 10}
            onClick={() => submit("approved", parsed)}
          >
            {busy === "approve" ? "Recording…" : "Send back at this amount"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setRevising(false);
              setAmountText("");
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
        {unchanged && (
          <p className="text-xs text-muted-foreground">
            That is the amount already in front of you — approve it instead.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {noting ? (
        <div className="space-y-1.5">
          <Label htmlFor={`note-${stage}`}>
            Your note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <textarea
            id={`note-${stage}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="e.g. Checked against the signed job card and the meter reading — figures agree."
          />
          <p className="text-xs text-muted-foreground">
            Recorded on the approval trail beside your name, and read by everyone
            further along the chain.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNoting(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <MessageSquarePlus className="size-3.5" /> Add a note (optional)
        </button>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => submit("approved")}>
          <Check className="mr-1.5 size-4" />
          {busy === "approve" ? "Recording…" : `${verb} — ${stageLabel}`}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            setRevising(true);
            setAmountText(amount != null ? String(amount) : "");
          }}
        >
          <PencilLine className="mr-1.5 size-4" />
          Approve a different amount
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => setReturning(true)}
        >
          <CornerUpLeft className="mr-1.5 size-4" />
          Send back
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => setRefusing(true)}
        >
          <X className="mr-1.5 size-4" />
          Refuse
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>Send back</strong> returns it to {returnsTo ?? "the desk below"}{" "}
        to correct and resend — the request stays alive.{" "}
        <strong>Refuse</strong> ends it.
      </p>
    </div>
  );
}
