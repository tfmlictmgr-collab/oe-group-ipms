import * as React from "react";
import { cn } from "@/lib/utils";

// Consistent page title block. `actions` sits right on desktop, wraps below on
// mobile so nothing is ever clipped.
//
// 📌 13 Sept 2026 — the heading stays in view. Asked for as "make the heading
// static across all features … for all roles / org / platform": a person
// scrolling a long register should still be able to see which screen they are
// on, and say its name. `data-page-head` is what globals.css pins under the
// top bar; the solid background and the bleed to the column edges are so the
// rows scrolling underneath disappear cleanly rather than showing through the
// title. The negative vertical margin cancels the padding, so nothing moves on
// a page that is not scrolled.
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-page-head
      className={cn(
        "-mx-4 -my-3 flex flex-col gap-3 bg-background px-4 py-3 sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
