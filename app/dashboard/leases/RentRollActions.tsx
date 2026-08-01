"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runAction, describeError } from "@/lib/run-action";
import { activateLease, renewLease, billRent } from "./actions";

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
    </div>
  );
}
