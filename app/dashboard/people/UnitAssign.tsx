"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select } from "@/components/ui/input";
import { assignUnitOccupant } from "../properties/actions";
import { runAction, describeError } from "@/lib/run-action";

type Unit = {
  id: string;
  label: string;
  property: string;
  occupantId: string | null;
  occupantName: string | null;
  /**
   * The database's answer (0200), not `occupantId == null`. A unit can be let
   * with no occupant recorded — a company tenancy with no portal user — and
   * without this the select would read "— vacant —" over an occupied flat.
   */
  isVacant: boolean;
};

export default function UnitAssign({
  units,
  tenants,
}: {
  units: Unit[];
  tenants: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function change(unitId: string, userId: string) {
    setBusy(unitId);
    try {
      await runAction(assignUnitOccupant(unitId, userId || null));
      toast.success(userId ? "Occupant assigned" : "Unit marked vacant");
      router.refresh();
    } catch (e) {
      toast.error("Could not update unit", {
        description: describeError(e),
      });
    } finally {
      setBusy(null);
    }
  }

  if (units.length === 0) {
    return <p className="text-sm text-muted-foreground">No units on your properties.</p>;
  }

  return (
    <ul className="space-y-2">
      {units.map((u) => (
        <li
          key={u.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{u.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {u.property}
              {!u.isVacant && !u.occupantId && " · let — no occupant recorded"}
            </p>
          </div>
          <Select
            aria-label={`Occupant of ${u.label}`}
            value={u.occupantId ?? ""}
            disabled={busy === u.id}
            onChange={(e) => change(u.id, e.target.value)}
            className="w-full max-w-[16rem] flex-shrink-0"
          >
            <option value="">— vacant —</option>
            {/* Keep the current occupant listed even if they aren't in the
                tenant list (e.g. role changed), so the select can't silently
                misrepresent who is in the unit. */}
            {u.occupantId && !tenants.some((t) => t.id === u.occupantId) && (
              <option value={u.occupantId}>{u.occupantName ?? "Current occupant"}</option>
            )}
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </Select>
        </li>
      ))}
    </ul>
  );
}
