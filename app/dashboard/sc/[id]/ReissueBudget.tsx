"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import { reopenBudgetForCorrection } from "./actions";

/**
 * Correct and re-issue (0329) — "fix the inputs, re-issue", as decided with the
 * requester. An invoiced budget's invoices are withdrawn and the budget goes
 * back to draft at the corrected total, where its method and shares can be put
 * right and the invoices generated again. Editing one tenant's invoice on its
 * own is deliberately not offered: the invoices must add up to the budget.
 */
export default function ReissueBudget({
  budgetId,
  totalAmount,
  description,
}: {
  budgetId: string;
  totalAmount: number;
  description: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [total, setTotal] = useState(String(totalAmount));
  const [desc, setDesc] = useState(description ?? "");
  const [reason, setReason] = useState("");

  function confirm() {
    startTransition(async () => {
      try {
        const { withdrawn } = await runAction(
          reopenBudgetForCorrection(budgetId, { totalAmount: total, description: desc, reason })
        );
        toast.success("Budget back in draft", {
          description: `${withdrawn} invoice${withdrawn === 1 ? "" : "s"} withdrawn. Fix the split if needed, then generate the invoices again.`,
        });
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (e) {
        toast.error(messageOf(e, "That budget could not be re-issued."), {
          description: hintOf(e), duration: Infinity, closeButton: true,
        });
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <PencilLine /> Correct and re-issue
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Correct and re-issue this budget?</AlertDialogTitle>
            <AlertDialogDescription>
              Every invoice raised from it is withdrawn and the budget returns to
              draft at the figures below. You can then correct the split and
              generate the invoices again. Refused if any invoice has a payment,
              an open payment request or a reported bank transfer against it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rb-total">Budget total</Label>
              <Input id="rb-total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rb-desc">Description</Label>
              <Input id="rb-desc" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rb-reason">What was wrong?</Label>
              <Input
                id="rb-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Total keyed without the generator diesel line"
              />
              <p className="text-xs text-muted-foreground">
                At least 10 characters. It stays on the record with your name.
              </p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || reason.trim().length < 10}
              onClick={(e) => { e.preventDefault(); confirm(); }}
            >
              {pending ? "Withdrawing…" : "Withdraw invoices and edit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
