"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const STATUSES = ["open", "in_progress", "resolved", "closed"];

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
  const [error, setError] = useState<string | null>(null);

  async function changeStatus(next: string) {
    if (next === status) return;
    setSaving(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase
      .from("tickets")
      .update({ status: next })
      .eq("id", ticketId);

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setStatus(next);
    setSaving(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-neutral-500">Status</label>
      <select
        value={status}
        disabled={saving}
        onChange={(e) => changeStatus(e.target.value)}
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm capitalize outline-none focus:border-neutral-800 focus:ring-1 focus:ring-neutral-800 disabled:opacity-50"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s} className="capitalize">
            {s.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      {saving && <span className="text-xs text-neutral-400">Saving…</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
