"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assignTicket } from "./actions";
import { runAction, describeError } from "@/lib/run-action";

type Option = { id: string; label: string };

/**
 * Dispatching a request to a contractor or an ops person.
 *
 * ⚠️ `placeOwners` steps back rather than blocking (board direction, 22 Aug
 * 2026). An administrator holds `tickets.assign` everywhere and the database
 * lets them dispatch anything — that is unchanged, and this is presentation
 * only. But a request on a property that already HAS a facilities or property
 * manager is that manager's to dispatch; an admin reaching past them is the
 * exception, not the default, and the screen should say so.
 *
 * Deliberately NOT disabled outright. An FM on leave, a request that has sat
 * three days, a manager who has left — a control that cannot be reached in
 * those cases is a dead end, and this codebase has repeatedly found that a
 * picker which can only refuse is worse than one that asks you to mean it.
 */
export default function AssignControl({
  ticketId,
  vendors,
  opsStaff,
  currentVendorId,
  currentOpsUserId,
  placeOwners = [],
}: {
  ticketId: string;
  vendors: Option[];
  opsStaff: Option[];
  currentVendorId: string | null;
  currentOpsUserId: string | null;
  /** FM/PM/regional managers attached to this request's property. Empty for
   *  anyone who is not an admin — they ARE the owner, so it never applies. */
  placeOwners?: { name: string; roleName: string }[];
}) {
  const [vendorId, setVendorId] = useState(currentVendorId ?? "");
  const [opsUserId, setOpsUserId] = useState(currentOpsUserId ?? "");
  const [pending, startTransition] = useTransition();
  const [overridden, setOverridden] = useState(false);

  const deferring = placeOwners.length > 0 && !overridden;

  function submit() {
    startTransition(async () => {
      try {
        await runAction(assignTicket(ticketId, vendorId || null, opsUserId || null));
        toast.success("Request dispatched", {
          description: "The assignee has been notified.",
        });
      } catch (e) {
        toast.error("Could not assign", {
          description: describeError(e),
        });
      }
    });
  }

  if (deferring) {
    const who = placeOwners
      .map((o) => `${o.name} (${o.roleName})`)
      .join(", ");
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Dispatch this request
        </p>
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          This property is managed by{" "}
          <span className="font-medium text-foreground">{who}</span>. Dispatching
          it is theirs to do — it is already on their board.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOverridden(true)}
        >
          Dispatch it anyway
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Dispatch this request
      </p>
      {overridden && placeOwners.length > 0 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Dispatching over{" "}
          {placeOwners.map((o) => o.name).join(", ")} — they manage this
          property. Recorded on the audit trail like any other dispatch.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vendor">Vendor</Label>
          <Select id="vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">— none —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ops">
            Ops staff <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select id="ops" value={opsUserId} onChange={(e) => setOpsUserId(e.target.value)}>
            <option value="">— none —</option>
            {opsStaff.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Button onClick={submit} disabled={pending} variant="brand">
        <Send />
        {pending
          ? "Assigning…"
          : currentVendorId || currentOpsUserId
            ? "Reassign"
            : "Assign & notify"}
      </Button>
    </div>
  );
}
