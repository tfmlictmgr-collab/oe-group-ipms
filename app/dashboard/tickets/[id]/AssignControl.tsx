"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assignTicket } from "./actions";

type Option = { id: string; label: string };

export default function AssignControl({
  ticketId,
  vendors,
  opsStaff,
  currentVendorId,
  currentOpsUserId,
}: {
  ticketId: string;
  vendors: Option[];
  opsStaff: Option[];
  currentVendorId: string | null;
  currentOpsUserId: string | null;
}) {
  const [vendorId, setVendorId] = useState(currentVendorId ?? "");
  const [opsUserId, setOpsUserId] = useState(currentOpsUserId ?? "");
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await assignTicket(ticketId, vendorId || null, opsUserId || null);
        toast.success("Request dispatched", {
          description: "The assignee has been notified.",
        });
      } catch (e) {
        toast.error("Could not assign", {
          description: e instanceof Error ? e.message : "Unexpected error.",
        });
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Dispatch this request
      </p>
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
