"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import { setPropertyStakeholder } from "../actions";

type Candidate = { id: string; name: string; role: string; roleName: string };

export default function StakeholderPanel({
  propertyId, brand, candidates, attached, canWrite,
}: {
  propertyId: string;
  brand: string | null;
  candidates: Candidate[];
  attached: { userId: string; relation: "manager" | "owner" }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const isAttached = (userId: string, relation: "manager" | "owner") =>
    attached.some((a) => a.userId === userId && a.relation === relation);

  async function toggle(c: Candidate, relation: "manager" | "owner") {
    const key = `${c.id}:${relation}`;
    setBusy(key);
    try {
      const next = !isAttached(c.id, relation);
      await runAction(setPropertyStakeholder(propertyId, c.id, relation, next));
      toast.success(
        next ? `${c.name} attached to this property` : `${c.name} detached`,
        { description: next ? "They can now see and act on it." : "Their access to it is removed." }
      );
      router.refresh();
    } catch (e) {
      toast.error("Could not change that", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No one to attach yet — invite a {brand === "OEA" ? "properties manager" : "facilities manager"} or
        a property owner under People first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {candidates.map((c) => {
        const relation = c.role === "property_owner" ? "owner" : "manager";
        const on = isAttached(c.id, relation);
        const key = `${c.id}:${relation}`;
        return (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                {c.roleName} · would be attached as {relation}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`Attach ${c.name} to this property`}
              disabled={!canWrite || busy === key}
              onClick={() => toggle(c, relation)}
              className={cn(
                "relative h-5 w-9 flex-shrink-0 rounded-full transition-colors",
                on ? "bg-[var(--brand)]" : "bg-muted",
                (!canWrite || busy === key) && "cursor-not-allowed opacity-60"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                  on ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </button>
          </div>
        );
      })}
      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          Read-only — changing attachments needs the portfolio management permission.
        </p>
      )}
    </div>
  );
}
