"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUSES = [
  "open",
  "assigned",
  "acknowledged",
  "in_progress",
  "resolved",
  "closed",
];

export default function TicketStatusControl({
  ticketId,
  currentStatus,
}: {
  ticketId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [saving, setSaving] = useState(false);

  async function changeStatus(next: string) {
    if (next === status) return;
    setSaving(true);

    const supabase = createClient();
    const { error } = await supabase
      .from("tickets")
      .update({ status: next })
      .eq("id", ticketId);

    if (error) {
      toast.error("Could not update status", { description: error.message });
      setSaving(false);
      return;
    }

    setStatus(next);
    setSaving(false);
    toast.success(`Status set to ${next.replace(/_/g, " ")}`);
    router.refresh();
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="status">Status</Label>
      <div className="flex items-center gap-3">
        <Select
          id="status"
          value={status}
          disabled={saving}
          onChange={(e) => changeStatus(e.target.value)}
          className="max-w-[14rem] capitalize"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s} className="capitalize">
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>
    </div>
  );
}
