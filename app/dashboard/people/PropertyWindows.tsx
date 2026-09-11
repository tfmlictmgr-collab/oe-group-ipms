"use client";

import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import { setPropertyApplicationState } from "./actions";

export type PropertyWindow = {
  property_id: string;
  name: string;
  applications_state: "auto" | "open" | "closed";
  accepting_now: boolean;
  unit_count: number;
  vacant_count: number;
};

const STATES = [
  { key: "auto", label: "Auto", hint: "Open while a unit is vacant" },
  { key: "open", label: "Open", hint: "Always open — keeps a waiting list" },
  { key: "closed", label: "Closed", hint: "Not taking applicants" },
] as const;

/**
 * Per-property intake.
 *
 * The board asked for the window to follow occupancy. It does, by default — but
 * with an override, because a landlord legitimately wants a waiting list on a
 * full building and legitimately wants a property closed while its units sit
 * empty. Deriving it with no way out would remove a judgement that belongs to a
 * person; the vacancy count is shown beside each row so the judgement is made
 * with the same facts the automation used.
 */
export default function PropertyWindows({
  rows,
  isAdmin,
}: {
  rows: PropertyWindow[];
  isAdmin: boolean;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);

  async function change(row: PropertyWindow, state: "auto" | "open" | "closed") {
    if (state === row.applications_state) return;
    setBusy(row.property_id);
    try {
      await runAction(setPropertyApplicationState(row.property_id, state));
      toast.success(`${row.name} — applications ${state === "auto" ? "follow vacancy" : state}`);
    } catch (err) {
      toast.error("Could not change it", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No properties yet. Add one to the register and it will appear here.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li
          key={row.property_id}
          className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{row.name}</span>
              {row.accepting_now ? (
                <Badge variant="success">Accepting</Badge>
              ) : (
                <Badge variant="outline">Not accepting</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.unit_count === 0
                ? "No units recorded"
                : `${row.vacant_count} of ${row.unit_count} unit${row.unit_count === 1 ? "" : "s"} vacant`}
              {row.applications_state !== "auto" && " · overridden"}
            </p>
          </div>

          <div className="flex flex-shrink-0 gap-1" role="group" aria-label={`Applications for ${row.name}`}>
            {STATES.map((s) => {
              const active = row.applications_state === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={!isAdmin || busy === row.property_id}
                  aria-pressed={active}
                  title={s.hint}
                  onClick={() => change(row, s.key)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    active
                      ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                    (!isAdmin || busy === row.property_id) && "cursor-not-allowed opacity-60"
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}
