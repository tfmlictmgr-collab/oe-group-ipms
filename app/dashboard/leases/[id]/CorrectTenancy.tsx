"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
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
import { correctLeaseTerms, correctRentCharge } from "../actions";

/**
 * Correcting a tenancy entered by mistake (0329). A draft changes freely; a
 * live tenancy needs a reason, which goes on the audit trail with what it was
 * and what it became. The database decides who may (`leases.write` on a
 * property they hold) and refuses an ended tenancy outright.
 */
export function CorrectTenancyButton({
  leaseId,
  status,
  terms,
}: {
  leaseId: string;
  status: string;
  terms: {
    rentAmount: number;
    rentFrequency: "annual" | "quarterly" | "monthly";
    depositAmount: number;
    escalationPct: number;
    startDate: string;
    endDate: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const initial = React.useMemo(
    () => ({
      rentAmount: String(terms.rentAmount),
      rentFrequency: terms.rentFrequency,
      depositAmount: String(terms.depositAmount ?? 0),
      escalationPct: String(terms.escalationPct ?? 0),
      startDate: terms.startDate,
      endDate: terms.endDate,
      reason: "",
    }),
    [terms]
  );
  const [form, setForm] = React.useState(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (!["draft", "active", "renewed"].includes(status)) return null;
  const isDraft = status === "draft";
  const needsReason = !isDraft;

  function save() {
    startTransition(async () => {
      try {
        await runAction(correctLeaseTerms(leaseId, form));
        toast.success(isDraft ? "Tenancy updated" : "Tenancy corrected", {
          description: isDraft ? undefined : "The change and your reason are on the audit trail.",
        });
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(messageOf(e, "That could not be corrected."), {
          description: hintOf(e), duration: Infinity, closeButton: true,
        });
      }
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setForm(initial); setOpen(true); }}>
        <PencilLine /> {isDraft ? "Edit details" : "Correct tenancy details"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{isDraft ? "Edit this tenancy" : "Correct this tenancy"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isDraft
                ? "Nothing has been billed on a draft, so its terms can be changed freely."
                : "For a figure entered by mistake. Rent already demanded keeps its own amount; correct a wrong demand from its row below. The unit and the tenant cannot change on a live tenancy."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ct-rent">Rent</Label>
              <Input id="ct-rent" inputMode="decimal" value={form.rentAmount}
                onChange={(e) => set("rentAmount", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-freq">Billed</Label>
              <Select id="ct-freq" value={form.rentFrequency}
                onChange={(e) => set("rentFrequency", e.target.value as typeof form.rentFrequency)}>
                <option value="annual">Annually</option>
                <option value="quarterly">Quarterly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-deposit">Deposit</Label>
              <Input id="ct-deposit" inputMode="decimal" value={form.depositAmount}
                onChange={(e) => set("depositAmount", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-esc">Escalation on renewal (%)</Label>
              <Input id="ct-esc" inputMode="decimal" value={form.escalationPct}
                onChange={(e) => set("escalationPct", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-start">Starts</Label>
              <Input id="ct-start" type="date" value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-end">Ends</Label>
              <Input id="ct-end" type="date" value={form.endDate}
                onChange={(e) => set("endDate", e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ct-reason">
                What was wrong{" "}
                {!needsReason && <span className="font-normal text-muted-foreground">(optional)</span>}
              </Label>
              <Input id="ct-reason" value={form.reason} placeholder="e.g. Rent keyed as 1,200,000 instead of 2,100,000"
                onChange={(e) => set("reason", e.target.value)} />
              {needsReason && (
                <p className="text-xs text-muted-foreground">
                  At least 10 characters. It stays on the record with your name.
                </p>
              )}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || (needsReason && form.reason.trim().length < 10)}
              onClick={(e) => { e.preventDefault(); save(); }}
            >
              {pending ? "Saving…" : isDraft ? "Save changes" : "Record correction"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Correcting one rent demand (0329) — offered only on a demand nothing has
 * happened to; the database refuses one with a payment, a payment request, an
 * off-platform claim, a posting or a remittance against it regardless.
 */
export function CorrectChargeButton({
  leaseId,
  charge,
}: {
  leaseId: string;
  charge: { id: string; amount: number; periodStart: string; periodEnd: string; dueDate: string | null };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const initial = {
    amount: String(charge.amount),
    periodStart: charge.periodStart,
    periodEnd: charge.periodEnd,
    dueDate: charge.dueDate ?? charge.periodStart,
    reason: "",
  };
  const [form, setForm] = React.useState(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function save() {
    startTransition(async () => {
      try {
        await runAction(correctRentCharge(leaseId, charge.id, form));
        toast.success("Rent demand corrected", {
          description: "The fee is recomputed at the rate on the demand; your reason is on the audit trail.",
        });
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(messageOf(e, "That demand could not be corrected."), {
          description: hintOf(e), duration: Infinity, closeButton: true,
        });
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setForm(initial); setOpen(true); }}
        className="ml-2 text-xs font-medium text-[var(--brand)] hover:underline"
        data-print="screen-only"
      >
        Correct
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Correct this rent demand</AlertDialogTitle>
            <AlertDialogDescription>
              Only while nothing has been paid, requested or posted against it. The
              management fee is recomputed at the rate already frozen on the demand.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cc-amount">Amount demanded</Label>
              <Input id="cc-amount" inputMode="decimal" value={form.amount}
                onChange={(e) => set("amount", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-from">Period from</Label>
              <Input id="cc-from" type="date" value={form.periodStart}
                onChange={(e) => set("periodStart", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-to">Period to</Label>
              <Input id="cc-to" type="date" value={form.periodEnd}
                onChange={(e) => set("periodEnd", e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cc-due">Due</Label>
              <Input id="cc-due" type="date" value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cc-reason">What was wrong</Label>
              <Input id="cc-reason" value={form.reason} placeholder="e.g. Demand raised before the rent was corrected"
                onChange={(e) => set("reason", e.target.value)} />
              <p className="text-xs text-muted-foreground">
                At least 10 characters. It stays on the record with your name.
              </p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || form.reason.trim().length < 10}
              onClick={(e) => { e.preventDefault(); save(); }}
            >
              {pending ? "Saving…" : "Record correction"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
