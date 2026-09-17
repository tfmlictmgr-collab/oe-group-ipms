"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import { setVendorProperty } from "../actions";

export type VendorOption = { id: string; name: string };

/**
 * Which contractors this organisation's FM/PM has explicitly said work here.
 *
 * ⚠️ NOT the same as "which vendors have jobs on this property". A vendor
 * dispatched a single ticket here shows up in the job history regardless of
 * this list. This list is the deliberate, standing association that scopes
 * what an FM/PM sees of a vendor's PAYMENTS and EVALUATIONS — narrower and
 * more sensitive than the work-order relationship, per 0012.
 */
export default function VendorPropertiesPanel({
  propertyId,
  vendors,
  attachedVendorIds,
  canWrite,
}: {
  propertyId: string;
  vendors: VendorOption[];
  attachedVendorIds: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function toggle(v: VendorOption) {
    setBusy(v.id);
    try {
      const next = !attachedVendorIds.includes(v.id);
      await runAction(setVendorProperty(propertyId, v.id, next));
      toast.success(
        next ? `${v.name} attached to this property` : `${v.name} detached`,
        {
          description: next
            ? "Their payments and evaluations for this property are now visible to this property's FM/PM."
            : undefined,
        }
      );
      router.refresh();
    } catch (e) {
      toast.error("Could not change that", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  if (vendors.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No vendors registered in this organisation yet — add one under Vendors first.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {vendors.map((v) => {
        const on = attachedVendorIds.includes(v.id);
        return (
          <button
            key={v.id}
            type="button"
            disabled={!canWrite || busy === v.id}
            onClick={() => toggle(v)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              on
                ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
              (!canWrite || busy === v.id) && "cursor-not-allowed opacity-60"
            )}
          >
            {v.name}
          </button>
        );
      })}
    </div>
  );
}
