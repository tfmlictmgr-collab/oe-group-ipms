"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, ChevronLeft, ChevronRight, Maximize, Minimize } from "lucide-react";
import type { Process } from "@/lib/guides/processes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Live slide mode — the fifth surface on the same one source, alongside the
// screen, the two PDFs and the generated deck. It can never go stale for the
// same reason the screen can't: it renders the exact `Process[]` the caller
// was already looking at (respecting whatever search/role filter was active),
// not a second copy fetched separately.
//
// Trainer notes are shown on-slide here rather than moved to speaker notes
// (unlike the generated .pptx, which has an actual presenter-notes pane) —
// this is a shared screen or a projector with no separate presenter view, so
// anything the trainer needs has to be readable by whoever is watching too.
export default function PresentMode({
  processes,
  roleName,
  trainerView,
  startAt,
  onExit,
}: {
  processes: Process[];
  roleName: (role: string) => string;
  trainerView: boolean;
  startAt?: string;
  onExit: () => void;
}) {
  type Slide = { kind: "agenda" } | { kind: "process"; process: Process } | { kind: "end" };
  const slides = useMemo<Slide[]>(
    () => [{ kind: "agenda" }, ...processes.map((p): Slide => ({ kind: "process", process: p })), { kind: "end" }],
    [processes]
  );

  const initialIndex = useMemo(() => {
    if (!startAt) return 0;
    const i = processes.findIndex((p) => p.id === startAt);
    return i === -1 ? 0 : i + 1; // +1 for the agenda slide ahead of it
  }, [processes, startAt]);

  const [index, setIndex] = useState(initialIndex);
  const [fullscreen, setFullscreen] = useState(false);
  const last = slides.length - 1;

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta))),
    [last]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onExit]);

  const toggleFullscreen = () => {
    // Best-effort: a shared-screen or sandboxed context may refuse this
    // silently, and the slide itself still works fine at window size.
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => {});
    }
  };

  const slide = slides[index];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {index + 1} of {slides.length}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" size="icon-sm" variant="ghost" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onExit}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-16 sm:py-12">
        <div className="mx-auto max-w-4xl">
          {slide.kind === "agenda" && <AgendaSlide processes={processes} />}
          {slide.kind === "process" && (
            <ProcessSlide process={slide.process} roleName={roleName} trainerView={trainerView} />
          )}
          {slide.kind === "end" && (
            <div className="flex h-full min-h-[50vh] flex-col items-center justify-center text-center">
              <p className="text-2xl font-semibold">That&apos;s every process in this session.</p>
              <p className="mt-2 text-muted-foreground">Press Esc, or the close button, to go back.</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <Button type="button" variant="outline" size="sm" onClick={() => go(-1)} disabled={index === 0}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => go(1)} disabled={index === last}>
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AgendaSlide({ processes }: { processes: Process[] }) {
  const modules: string[] = [];
  const counts = new Map<string, number>();
  for (const p of processes) {
    if (!counts.has(p.module)) { modules.push(p.module); counts.set(p.module, 0); }
    counts.set(p.module, counts.get(p.module)! + 1);
  }
  return (
    <div>
      <h1 className="mb-6 text-3xl font-semibold">Agenda</h1>
      <ul className="space-y-3 text-lg">
        {modules.map((m) => (
          <li key={m} className="flex items-baseline justify-between border-b border-border pb-2">
            <span>{m}</span>
            <span className="text-sm text-muted-foreground">{counts.get(m)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProcessSlide({
  process, roleName, trainerView,
}: { process: Process; roleName: (r: string) => string; trainerView: boolean }) {
  return (
    <div className="space-y-5">
      <div>
        <Badge variant="outline" className="mb-2">{process.module}</Badge>
        <h1 className="text-2xl font-semibold sm:text-3xl">{process.title}</h1>
        <p className="mt-1 italic text-muted-foreground">Starts when: {process.startsWhen}</p>
      </div>

      <ol className="space-y-3">
        {process.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <Badge variant={step.role === "system" ? "outline" : "default"} className="mt-0.5 shrink-0">
              {step.role === "system" ? "Automatic" : roleName(step.role)}
            </Badge>
            <span>{step.action}</span>
          </li>
        ))}
      </ol>

      <div className="rounded-md bg-success/10 px-4 py-3">
        <span className="font-medium text-success-onTint">Done means: </span>
        {process.doneMeans}
      </div>

      {process.refusals?.map((r, i) => (
        <div key={i} className="rounded-md bg-warning/10 px-4 py-3">
          <p className="font-medium text-warning-onTint">{r.trigger}</p>
          <p className="text-muted-foreground">{r.explanation}</p>
        </div>
      ))}

      {trainerView && (
        <div className="space-y-1 rounded-md border border-dashed border-border px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            For the trainer
          </p>
          <p><span className="font-medium">Demo: </span>{process.trainer.demo}</p>
          {process.trainer.commonMistake && (
            <p><span className="font-medium">Common mistake: </span>{process.trainer.commonMistake}</p>
          )}
          <p><span className="font-medium">Practice exercise: </span>{process.trainer.exercise}</p>
        </div>
      )}
    </div>
  );
}
