"use client";

import { useState, useTransition } from "react";
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
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await assignTicket(ticketId, vendorId || null, opsUserId || null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to assign");
      }
    });
  }

  const fieldClass =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none ring-brand";

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <h3 className="mb-3 text-sm font-semibold text-neutral-700">
        Dispatch this request
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-neutral-500">Vendor</label>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className={fieldClass}
          >
            <option value="">— none —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-500">
            Ops staff (optional)
          </label>
          <select
            value={opsUserId}
            onChange={(e) => setOpsUserId(e.target.value)}
            className={fieldClass}
          >
            <option value="">— none —</option>
            {opsStaff.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-lg btn-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending
            ? "Assigning…"
            : currentVendorId || currentOpsUserId
              ? "Reassign"
              : "Assign & notify"}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
