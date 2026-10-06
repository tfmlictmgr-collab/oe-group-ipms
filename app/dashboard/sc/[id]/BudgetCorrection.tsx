"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Trash2 } from "lucide-react";
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
import { voidBudget, deleteBudget } from "./actions";

/**
 * The way out for a budget filed in error (0315). A draft nothing ever
 * referenced is deleted; anything invoiced is voided, because its invoices are
 * financial records. Neither moves the budget to another property — the right
 * one gets a new budget.
 */
export default function BudgetCorrection({
  budgetId,
  status,
  propertyName,
  period,
}: {
  budgetId: string;
  status: string;
  propertyName: string;
  period: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<"void" | "delete" | null>(null);
  const [reason, setReason] = useState("");

  if (status === "void") return null;
  const isDraft = status === "draft";

  function confirm() {
    startTransition(async () => {
      try {
        if (open === "delete") {
          await runAction(deleteBudget(budgetId));
          toast.success("Budget deleted", {
            description: "It is recorded in the audit trail.",
          });
          router.push("/dashboard/sc");
        } else {
          await runAction(voidBudget(budgetId, reason));
          toast.success("Budget voided", {
            description: "Its invoices are retired. You can now raise the budget again on the right property.",
          });
          setOpen(null);
          setReason("");
        }
      } catch (e) {
        toast.error(messageOf(e, "That could not be done."), {
          description: hintOf(e), duration: Infinity, closeButton: true,
        });
      }
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(isDraft ? "delete" : "void")}
      >
        {isDraft ? <Trash2 /> : <Ban />}
        {isDraft ? "Delete budget" : "Void budget"}
      </Button>

      <AlertDialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {open === "delete" ? "Delete this budget?" : "Void this budget?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {open === "delete" ? (
                <>
                  The {period} budget for {propertyName} has never been invoiced, so it
                  can be removed outright. The deletion is kept in the audit trail.
                </>
              ) : (
                <>
                  Every invoice raised from the {period} budget for {propertyName} is
                  retired, and the budget is closed for good. It is refused if any of
                  those invoices has money attached. A budget cannot be moved to
                  another property; raise a new one on the right property afterwards.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {open === "void" && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="void-reason">Why is this budget being voided?</Label>
              <Input
                id="void-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Raised against the wrong property"
              />
              <p className="text-xs text-muted-foreground">
                At least 10 characters. It stays on the record with your name.
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || (open === "void" && reason.trim().length < 10)}
              onClick={(e) => { e.preventDefault(); confirm(); }}
            >
              {pending
                ? open === "delete" ? "Deleting…" : "Voiding…"
                : open === "delete" ? "Delete budget" : "Void budget"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
