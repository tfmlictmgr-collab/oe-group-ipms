"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { runAction, describeError } from "@/lib/run-action";
import { activateLease, renewLease, billRent, endTenancy } from "./actions";

/**
 * Per-lease actions on the rent roll.
 *
 * What is offered follows the lease's own state — a draft is activated, a live
 * tenancy is billed or renewed — but every one of these is re-checked in the
 * database. `leases.write`, the property scoping and the "one unit, one
 * tenancy" rule are all enforced there; this only decides what to show.
 */
export default function RentRollActions({
  leaseId,
  status,
  endDate,
}: {
  leaseId: string;
  status: string;
  endDate: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [ending, setEnding] = React.useState(false);
  const [reason, setReason] = React.useState("");

  // Whether the term still has time to run decides the word the database will
  // use — terminated before the end date, expired at or after it. Shown here so
  // the confirmation says which one is about to be recorded, rather than
  // leaving someone to discover it on the rent roll afterwards.
  const stillRunning = new Date(endDate) > new Date();

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(`Could not ${label}`, {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  if (status === "draft") {
    return (
      <Button
        type="button" size="sm" variant="brand" disabled={busy !== null}
        onClick={() =>
          run("activate this tenancy", () => runAction(activateLease(leaseId)),
            "Tenancy activated — the unit now shows as occupied")
        }
      >
        Activate
      </Button>
    );
  }

  if (status !== "active" && status !== "renewed") return null;

  // A year from the term's end, which is what a renewal almost always is here.
  const nextYearEnd = new Date(endDate);
  nextYearEnd.setFullYear(nextYearEnd.getFullYear() + 1);

  return (
    <div className="flex justify-end gap-1.5">
      <Button
        type="button" size="sm" variant="outline" disabled={busy !== null}
        title="Raise the demand for the current term"
        onClick={() =>
          run("bill this period",
            () => runAction(billRent(leaseId, new Date().toISOString().slice(0, 10),
              endDate, new Date().toISOString().slice(0, 10))),
            "Rent demand raised")
        }
      >
        Bill rent
      </Button>
      <Button
        type="button" size="sm" variant="outline" disabled={busy !== null}
        title="Start a new 12-month term with the escalation applied"
        onClick={() =>
          run("renew this tenancy", () => runAction(renewLease(leaseId, 12)),
            "Renewed for 12 months — the escalation is on the new term")
        }
      >
        Renew
      </Button>
      <Button
        type="button" size="sm" variant="outline" disabled={busy !== null}
        title="Record that this tenancy has ended and the unit is back"
        onClick={() => setEnding(true)}
      >
        End tenancy
      </Button>

      {/* Confirmed rather than fired on a tap: this is the one action here that
          empties a home in the register, and it re-opens the property to
          applicants. The reason is optional but asked for — it lands in the
          audit trail beside who ended it, and "moved abroad" versus "removed
          for arrears" is the difference between a record and a row. */}
      <AlertDialog open={ending} onOpenChange={setEnding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this tenancy?</AlertDialogTitle>
            <AlertDialogDescription>
              {stillRunning
                ? "The term still has time to run, so this is recorded as a termination."
                : "The term has run out, so this is recorded as an expiry."}{" "}
              The unit becomes vacant, and if its intake is on Auto the property
              starts taking applications again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor={`end-reason-${leaseId}`}>
              Why has it ended?{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`end-reason-${leaseId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Keys returned 24 Aug — moving to Abuja"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Leave it running</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run("end this tenancy", () => runAction(endTenancy(leaseId, reason)),
                  "Tenancy ended — the unit is vacant again")
              }
            >
              End tenancy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
