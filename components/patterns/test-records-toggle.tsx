"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Show test records" — present only when the screen holds some (0321).
 * Toggles ?test=1 and keeps every other filter on the URL, so turning test
 * records on or off never changes what else the reader had chosen.
 */
export function TestRecordsToggle({ count, className }: { count: number; className?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  if (count === 0) return null;
  const shown = params.get("test") === "1";
  const next = new URLSearchParams(params.toString());
  if (shown) next.delete("test"); else next.set("test", "1");
  const qs = next.toString();
  return (
    <Link
      href={qs ? `${pathname}?${qs}` : pathname}
      data-print="screen-only"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        shown ? "border-warning/60 bg-warning/10 font-medium" : "text-muted-foreground hover:bg-muted",
        className
      )}
    >
      <FlaskConical className="size-3.5" />
      {shown ? `Hide test records (${count})` : `Show test records (${count})`}
    </Link>
  );
}

/** The label a test record carries wherever it is shown. */
export function TestBadge({ className }: { className?: string }) {
  return (
    <span
      title="Test record from a walkthrough or rehearsal. Kept because money touched it; not real activity."
      className={cn("ml-2 inline-flex items-center rounded border border-warning/60 bg-warning/15 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide", className)}
    >
      Test
    </span>
  );
}
