"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitBranch, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAction, describeError } from "@/lib/run-action";
import { setApprovalChainShape, setApprovalBands } from "./actions";

/**
 * How many desks a payment climbs in this organisation, and whether the last
 * one checks an amount band.
 *
 * ⚠️ This lives on the operator launcher and NOWHERE else. Decision 7 names
 * payment approval among the controls that "stay hardwired and never appear as
 * toggles" in an organisation's own settings, and decision 23 took
 * `delivery_brand` out of the org-writable allowlist the moment it began
 * choosing a ladder — an administrator able to switch off the band they approve
 * against is approving against nothing. `operator_set_approval_chain` (0248)
 * and `operator_set_approval_tiers` (0261) both gate on
 * `caller_is_operator_admin()` and audit themselves; this is the switch those
 * two shipped without.
 *
 * 📌 The wording matters more than usual here. An operator reading "tiers" has
 * to know what turning them off does and does not do — it removes the
 * AMOUNT BAND on the final stage, and removes nothing else: the chain still
 * runs in full, one human still cannot hold two stages, and only the payment
 * officer still disburses. Saying that on the control is cheaper than
 * discovering it after.
 */

const SHAPES: {
  value: "standard" | "oea" | "single_stage" | "";
  label: string;
  detail: string;
}[] = [
  {
    value: "",
    label: "From the brand",
    detail: "OEA organisations get the OEA ladder; everything else the standard one.",
  },
  {
    value: "standard",
    label: "Standard · 3 stages",
    detail: "Work signed off → audit verification → final approval.",
  },
  {
    value: "oea",
    label: "OEA · 3 stages",
    detail: "Audit review → Managing Partner → payment approval.",
  },
  {
    value: "single_stage",
    label: "Single stage",
    detail:
      "One rung, and it is the payment approval — collapsing a ladder keeps the stage that authorises money leaving.",
  },
];

export default function ApprovalChainField({
  orgId,
  orgName,
  shape,
  bandsEnabled,
}: {
  orgId: string;
  orgName: string;
  shape: string | null;
  bandsEnabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const current = SHAPES.find((s) => s.value === (shape ?? "")) ?? SHAPES[0];

  async function chooseShape(value: "standard" | "oea" | "single_stage" | "") {
    setBusy(true);
    try {
      await runAction(setApprovalChainShape(orgId, value === "" ? null : value));
      toast.success(`${orgName}: ${SHAPES.find((s) => s.value === value)?.label}`, {
        description:
          "Applies to payables from now on. Anything already part-way up its ladder keeps the stages it has.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Could not change the approval chain", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleBands(next: boolean) {
    setBusy(true);
    try {
      await runAction(setApprovalBands(orgId, next));
      toast.success(next ? `${orgName}: amount bands ON` : `${orgName}: amount bands OFF`, {
        description: next
          ? "The final approver must now carry a tier that covers the amount."
          : "The chain still runs in full — only the amount band is gone. One person still cannot hold two stages, and only the payment officer disburses.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Could not change the bands", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        // ⚠️ `preventDefault`, not just a handler. The whole org card is wrapped
        // in a `<Link>` to that organisation's own front door, so a click here
        // bubbles up and NAVIGATES — which is exactly what happened the first
        // time this was rendered: the panel never opened, the browser went to
        // /o/<slug>, and nothing looked broken. `DomainField` beside it has
        // carried the same two calls since it was written.
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate">
          {current.label}
          {bandsEnabled ? " · banded" : ""}
        </span>
      </button>
    );
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-muted/30 p-2.5"
      // Every click inside the open panel, for the same reason as above — a
      // radio, a checkbox and a Done button are all inside the card's link.
      onClick={(e) => e.preventDefault()}
    >
      <p className="eyebrow text-muted-foreground">Approval chain</p>

      <div className="space-y-1">
        {SHAPES.map((s) => {
          const selected = (shape ?? "") === s.value;
          return (
            <button
              key={s.value || "inherit"}
              type="button"
              disabled={busy}
              onClick={() => chooseShape(s.value)}
              className={[
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                selected ? "bg-background font-medium" : "hover:bg-background/60",
              ].join(" ")}
            >
              <span className="mt-0.5 size-3.5 shrink-0">
                {selected ? <Check className="size-3.5" /> : null}
              </span>
              <span>
                {s.label}
                <span className="block text-[11px] font-normal text-muted-foreground">
                  {s.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-border pt-2">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={bandsEnabled}
            disabled={busy}
            onChange={(e) => toggleBands(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Check the approver&apos;s amount band
            <span className="block text-[11px] text-muted-foreground">
              Off by default. With it off the chain still runs in full — what is
              removed is the requirement that the final approver&apos;s tier
              cover the amount.
            </span>
          </span>
        </label>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={() => setOpen(false)}
      >
        Done
      </Button>
    </div>
  );
}
