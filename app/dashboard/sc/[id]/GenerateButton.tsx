"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { FileOutput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateInvoices } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

export default function GenerateButton({
  budgetId,
  alreadyInvoiced,
  /**
   * Why generation would be refused right now, if it would be. Disabled rather
   * than hidden — the payouts page settled that pattern for a control someone
   * may see and not press, because a missing button is a mystery and a disabled
   * one carrying its reason is an instruction.
   *
   * ⚠️ Advisory only. `generateInvoices` re-asks `sc_manual_shares_state()`
   * server-side and refuses regardless of what this renders.
   */
  blockedReason = null,
}: {
  budgetId: string;
  alreadyInvoiced: boolean;
  blockedReason?: string | null;
}) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const { unaddressed } = await runAction(generateInvoices(budgetId));
        if (unaddressed.length > 0) {
          toast.warning("Invoices generated — some are addressed to nobody", {
            description: `${unaddressed.join(", ")}: the recorded occupant's account is deactivated, so ${unaddressed.length === 1 ? "that invoice was" : "those invoices were"} raised unaddressed. Clear or reassign the occupant under People → Unit Occupancy, then regenerate.`,
            duration: 15000,
          });
        } else {
          toast.success("Invoices generated", {
            description: "Each occupant's statement has been updated.",
          });
        }
      } catch (e) {
        toast.error("Could not generate invoices", {
          description: describeError(e),
        });
      }
    });
  }

  const button = (
    <Button
      onClick={handleClick}
      disabled={pending || blockedReason !== null}
      variant="brand"
      size="sm"
      title={blockedReason ?? undefined}
    >
      <FileOutput />
      {pending
        ? "Generating…"
        : alreadyInvoiced
          ? "Regenerate invoices"
          : "Generate invoices"}
    </Button>
  );

  if (!blockedReason) return button;

  return (
    <span className="flex flex-col items-end gap-1">
      {button}
      <span className="text-xs text-warning">Not yet — {blockedReason}.</span>
    </span>
  );
}
