"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// The one drawer every dashboard opens its interactive tiles onto —
// generalised from the analytics drill-down (Task 4) rather than a second
// copy of it.
//
// ⚠️ NO DATA FETCH LIVES HERE, deliberately. The analytics drawer re-queries
// because a drill target is a URL someone can reach directly, outside
// whatever scoped it the first click. A dashboard tile has no such second
// door: it opens on data the SERVER ALREADY FETCHED, under the viewer's own
// RLS-scoped session, to render the page the tile sits on. Re-querying here
// would be a second trip for information the client already legitimately
// holds — this is a viewer, not a boundary.
//
// One instance per page. Each tile calls `open(...)` with what to show;
// `<RecordDrawer state={state} onClose={...} />` renders whichever is open.

export type DrawerRecord = {
  id: string;
  title: string;
  meta?: string;
  /** success | warning | destructive | info | undefined (neutral) */
  tone?: "success" | "warning" | "destructive" | "info";
  tag?: string;
  href?: string;
};

export type DrawerState = {
  eyebrow: string;
  title: string;
  scope?: string;
  facts?: [string, React.ReactNode][];
  records: DrawerRecord[];
  emptyLabel?: string;
} | null;

const TONE_CLASS: Record<string, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning-on-tint",
  destructive: "bg-destructive/15 text-destructive",
  info: "bg-info/15 text-info",
};
const RAIL_CLASS: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
};

export function useDrawer() {
  const [state, setState] = React.useState<DrawerState>(null);
  return {
    state,
    open: (s: NonNullable<DrawerState>) => setState(s),
    close: () => setState(null),
  };
}

export function RecordDrawer({
  state,
  onClose,
}: {
  state: DrawerState;
  onClose: () => void;
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!state) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity",
          state ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={state?.title ?? "Detail"}
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl transition-transform duration-200",
          state ? "translate-x-0" : "translate-x-full"
        )}
      >
        {state && (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {state.eyebrow}
                </p>
                <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight">{state.title}</h2>
                {state.scope && <p className="mt-1 text-sm text-muted-foreground">{state.scope}</p>}
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex size-7 flex-shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
              >
                <X className="size-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {state.facts && state.facts.length > 0 && (
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {state.facts.map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="text-right font-medium tabular-nums">{v}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}

              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Behind this figure
              </p>

              {state.records.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  {state.emptyLabel ?? "Nothing here right now."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {state.records.map((r) => {
                    const inner = (
                      <div className="flex items-stretch gap-2.5 rounded-lg border border-border px-3 py-2.5">
                        <span
                          className={cn(
                            "w-[3px] flex-shrink-0 self-stretch rounded-full",
                            r.tone ? RAIL_CLASS[r.tone] : "bg-border"
                          )}
                        />
                        <div className="min-w-0 flex-1 self-center">
                          <p className="truncate text-sm font-medium">{r.title}</p>
                          {r.meta && <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.meta}</p>}
                        </div>
                        {r.tag && (
                          <span
                            className={cn(
                              "flex-shrink-0 self-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              r.tone ? TONE_CLASS[r.tone] : "bg-muted text-muted-foreground"
                            )}
                          >
                            {r.tag}
                          </span>
                        )}
                      </div>
                    );
                    return (
                      <li key={r.id}>
                        {r.href ? (
                          <Link href={r.href} className="block rounded-lg transition-colors hover:bg-accent/40">
                            {inner}
                          </Link>
                        ) : (
                          inner
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
