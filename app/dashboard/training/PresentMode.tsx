"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  X, ChevronLeft, ChevronRight, Maximize, Minimize, LayoutGrid, NotebookPen,
} from "lucide-react";
import type { Process, ProcessStep, ProcessRefusal } from "@/lib/guides/processes";

// Live slide mode: the fifth surface on the same one source, alongside the
// screen, the two PDFs and the generated deck. It renders the exact
// `Process[]` the caller was already looking at (whatever search or role
// filter was active), never a second copy fetched separately, so it cannot go
// stale either.
//
// It is a DECK, not a scrolling page (7 Oct 2026: "make the presentation view
// look like actual presentation slides"). Every slide is a fixed 16:9 canvas
// laid out at 1280×720 and scaled to fit the window, so a projector, a laptop
// and a shared Teams window all show the same slide with the same line breaks.
// A process becomes several slides (overview, its steps in pages of a few,
// what gets refused, and a practice slide in the trainer view) rather than one
// page that had to be scrolled in front of a room.
//
// Trainer notes (the demo and the common mistake) sit in a notes strip under
// the slide, toggled with N, instead of on the slide itself: the room sees the
// slide, the trainer sees both. The practice exercise IS on a slide, because
// the room needs to read it.

const W = 1280;
const H = 720;

type Slide =
  | { kind: "cover" }
  | { kind: "agenda" }
  | { kind: "section"; module: string; number: number; count: number }
  | { kind: "overview"; process: Process }
  | { kind: "steps"; process: Process; steps: { n: number; step: ProcessStep }[]; page: number; pages: number; total: number }
  | { kind: "refusals"; process: Process; refusals: ProcessRefusal[]; page: number; pages: number }
  | { kind: "practice"; process: Process }
  | { kind: "end" };

// Pages are cut by text length as well as count: one long step is worth two
// short ones, and a slide that overflows its canvas is the fault this file
// exists to remove.
function paginate<T>(items: T[], size: (t: T) => number, budget: number, maxPer: number): T[][] {
  const pages: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const s = size(it);
    if (cur.length > 0 && (cur.length >= maxPer || used + s > budget)) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += s;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function buildDeck(processes: Process[], trainerView: boolean): Slide[] {
  const modules: string[] = [];
  const byModule = new Map<string, Process[]>();
  for (const p of processes) {
    if (!byModule.has(p.module)) { modules.push(p.module); byModule.set(p.module, []); }
    byModule.get(p.module)!.push(p);
  }

  const slides: Slide[] = [{ kind: "cover" }, { kind: "agenda" }];
  modules.forEach((m, i) => {
    const list = byModule.get(m)!;
    slides.push({ kind: "section", module: m, number: i + 1, count: list.length });
    for (const p of list) {
      slides.push({ kind: "overview", process: p });
      const numbered = p.steps.map((step, k) => ({ n: k + 1, step }));
      const stepPages = paginate(numbered, (s) => 140 + s.step.action.length, 1150, 4);
      stepPages.forEach((steps, k) =>
        slides.push({ kind: "steps", process: p, steps, page: k + 1, pages: stepPages.length, total: p.steps.length })
      );
      const refusalPages = paginate(p.refusals ?? [], (r) => 80 + r.trigger.length + r.explanation.length, 900, 3);
      refusalPages.forEach((refusals, k) =>
        slides.push({ kind: "refusals", process: p, refusals, page: k + 1, pages: refusalPages.length })
      );
      if (trainerView) slides.push({ kind: "practice", process: p });
    }
  });
  slides.push({ kind: "end" });
  return slides;
}

export default function PresentMode({
  processes,
  roleName,
  trainerView,
  startAt,
  orgName,
  audience,
  onExit,
}: {
  processes: Process[];
  roleName: (role: string) => string;
  trainerView: boolean;
  startAt?: string;
  /** Shown on the cover and in every slide's footer. */
  orgName?: string;
  /** The role the deck was filtered to, if any, for the cover. */
  audience?: string;
  onExit: () => void;
}) {
  const slides = useMemo(() => buildDeck(processes, trainerView), [processes, trainerView]);

  const initialIndex = useMemo(() => {
    if (!startAt) return 0;
    const i = slides.findIndex((s) => s.kind === "overview" && s.process.id === startAt);
    return i === -1 ? 0 : i;
  }, [slides, startAt]);

  const [index, setIndex] = useState(initialIndex);
  const [fullscreen, setFullscreen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(trainerView);
  const [gridOpen, setGridOpen] = useState(false);
  const last = slides.length - 1;
  const current = Math.min(index, last);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta))),
    [last]
  );

  const toggleFullscreen = useCallback(() => {
    // Best-effort: a shared-screen or sandboxed context may refuse this
    // silently, and the deck still works at window size.
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (gridOpen) {
        if (e.key === "Escape" || e.key.toLowerCase() === "g") setGridOpen(false);
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(last);
      else if (e.key.toLowerCase() === "n" && trainerView) setNotesOpen((v) => !v);
      else if (e.key.toLowerCase() === "g") setGridOpen(true);
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
      else if (e.key === "Escape" && !document.fullscreenElement) onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, last, onExit, gridOpen, trainerView, toggleFullscreen]);

  // Swipe on a touch screen, so a tablet can drive the deck.
  const touchX = useRef<number | null>(null);

  // Scale the 1280×720 canvas to the space actually available.
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setScale(Math.max(0.1, Math.min(r.width / W, r.height / H)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [notesOpen]);

  const slide = slides[current];
  const notesProcess =
    slide.kind === "overview" || slide.kind === "steps" || slide.kind === "refusals" || slide.kind === "practice"
      ? slide.process
      : null;
  const ctx: Ctx = { processes, roleName, orgName, audience, trainerView, index: current, total: slides.length };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950 text-white" role="dialog" aria-label="Presentation">
      {/* Progress */}
      <div className="h-1 w-full bg-white/10">
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${((current + 1) / slides.length) * 100}%`, background: "var(--brand-accent, var(--brand))" }}
        />
      </div>

      <div
        ref={stageRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden p-4 sm:p-8"
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (start == null || end == null || Math.abs(end - start) < 50) return;
          go(end < start ? 1 : -1);
        }}
      >
        <div style={{ width: W * scale, height: H * scale }} className="relative shrink-0 shadow-2xl shadow-black/60">
          <div
            style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left" }}
            className="absolute left-0 top-0"
          >
            <SlideView slide={slide} ctx={ctx} />
          </div>
        </div>
      </div>

      {trainerView && notesOpen && (
        <div className="max-h-[22vh] overflow-y-auto border-t border-white/10 bg-neutral-900 px-6 py-3 text-sm leading-relaxed text-neutral-200">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Trainer notes, not shown on the slide
          </p>
          {notesProcess ? (
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <p><span className="font-semibold text-white">Demo: </span>{notesProcess.trainer.demo}</p>
              {notesProcess.trainer.commonMistake && (
                <p><span className="font-semibold text-white">Common mistake: </span>{notesProcess.trainer.commonMistake}</p>
              )}
            </div>
          ) : (
            <p className="text-neutral-400">
              Arrow keys or space to move · G for all slides · F for full screen · N hides these notes · Esc to leave.
            </p>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between gap-2 border-t border-white/10 bg-neutral-950 px-3 py-2 text-sm">
        <div className="flex items-center gap-1">
          <CtrlButton label="Previous slide" onClick={() => go(-1)} disabled={current === 0}>
            <ChevronLeft className="size-5" />
          </CtrlButton>
          <span className="min-w-[5.5rem] text-center tabular-nums text-neutral-300">
            {current + 1} / {slides.length}
          </span>
          <CtrlButton label="Next slide" onClick={() => go(1)} disabled={current === last}>
            <ChevronRight className="size-5" />
          </CtrlButton>
        </div>
        <p className="hidden truncate text-neutral-400 md:block">
          {notesProcess ? `${notesProcess.module} · ${notesProcess.title}` : orgName ?? "Training"}
        </p>
        <div className="flex items-center gap-1">
          {trainerView && (
            <CtrlButton label={notesOpen ? "Hide trainer notes (N)" : "Show trainer notes (N)"} onClick={() => setNotesOpen((v) => !v)} active={notesOpen}>
              <NotebookPen className="size-4" />
            </CtrlButton>
          )}
          <CtrlButton label="All slides (G)" onClick={() => setGridOpen(true)}>
            <LayoutGrid className="size-4" />
          </CtrlButton>
          <CtrlButton label={fullscreen ? "Leave full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </CtrlButton>
          <CtrlButton label="Close presentation (Esc)" onClick={onExit}>
            <X className="size-4" />
          </CtrlButton>
        </div>
      </div>

      {gridOpen && (
        <SlideGrid
          slides={slides}
          ctx={ctx}
          current={current}
          onPick={(i) => { setIndex(i); setGridOpen(false); }}
          onClose={() => setGridOpen(false)}
        />
      )}
    </div>
  );
}

function CtrlButton({
  label, onClick, disabled, active, children,
}: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex size-9 items-center justify-center rounded-md text-neutral-200 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30 disabled:hover:bg-transparent ${active ? "bg-white/15" : ""}`}
    >
      {children}
    </button>
  );
}

function SlideGrid({
  slides, ctx, current, onPick, onClose,
}: { slides: Slide[]; ctx: Ctx; current: number; onPick: (i: number) => void; onClose: () => void }) {
  const thumb = 0.18;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "center" }); }, []);
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-neutral-950/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="font-semibold">All slides</p>
        <CtrlButton label="Back to the slide (Esc)" onClick={onClose}><X className="size-4" /></CtrlButton>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="grid justify-center gap-5" style={{ gridTemplateColumns: `repeat(auto-fill, ${W * thumb}px)` }}>
          {slides.map((s, i) => (
            <button
              key={i}
              ref={i === current ? ref : undefined}
              type="button"
              onClick={() => onPick(i)}
              className="group text-left"
              aria-label={`Go to slide ${i + 1}`}
            >
              <div
                className={`relative overflow-hidden rounded-sm ring-2 transition ${i === current ? "ring-[color:var(--brand-accent,var(--brand))]" : "ring-transparent group-hover:ring-white/50"}`}
                style={{ width: W * thumb, height: H * thumb }}
              >
                <div style={{ width: W, height: H, transform: `scale(${thumb})`, transformOrigin: "top left" }} className="pointer-events-none absolute left-0 top-0">
                  <SlideView slide={s} ctx={{ ...ctx, index: i }} />
                </div>
              </div>
              <p className="mt-1 text-xs tabular-nums text-neutral-400">{i + 1}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Slides ─────────────────────────────────────────────────────────────────
// Each is drawn at 1280×720 with fixed pixel sizes. The slide stays light in
// dark mode on purpose: it is a projected document, and a projector washes out
// light text on dark far worse than the reverse.

type Ctx = {
  processes: Process[];
  roleName: (role: string) => string;
  orgName?: string;
  audience?: string;
  trainerView: boolean;
  index: number;
  total: number;
};

const BRAND = "var(--brand, #1f2937)";
const ACCENT = "var(--brand-accent, var(--brand, #1f2937))";

function SlideView({ slide, ctx }: { slide: Slide; ctx: Ctx }) {
  switch (slide.kind) {
    case "cover": return <CoverSlide ctx={ctx} />;
    case "agenda": return <AgendaSlide ctx={ctx} />;
    case "section": return <SectionSlide slide={slide} ctx={ctx} />;
    case "overview": return <OverviewSlide process={slide.process} ctx={ctx} />;
    case "steps": return <StepsSlide slide={slide} ctx={ctx} />;
    case "refusals": return <RefusalsSlide slide={slide} ctx={ctx} />;
    case "practice": return <PracticeSlide process={slide.process} ctx={ctx} />;
    case "end": return <EndSlide ctx={ctx} />;
  }
}

/** A content slide: brand rule at the top, a kicker and title, body, footer.
 *
 * Pagination is by text length, which is a good guess and never a guarantee,
 * so the body also measures itself and steps its own size down (to 75% at
 * most) until it fits. A slide never clips a sentence in front of a room. */
function Frame({
  ctx, kicker, title, children,
}: { ctx: Ctx; kicker: string; title: string; children: React.ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const inner = innerRef.current;
    if (!body || !inner) return;
    let f = 1;
    inner.style.zoom = "1";
    while (body.scrollHeight > body.clientHeight + 1 && f > 0.76) {
      f = Math.round((f - 0.05) * 100) / 100;
      inner.style.zoom = String(f);
    }
    setFit(f);
  }, [children]);
  return (
    <div className="flex h-full w-full flex-col bg-white text-slate-900">
      <div className="h-3 w-full" style={{ background: BRAND }} />
      <div className="px-16 pt-10">
        <p className="text-[18px] font-semibold uppercase tracking-[0.18em]" style={{ color: BRAND }}>{kicker}</p>
        <h2 className="mt-2 text-[40px] font-bold leading-[1.15] tracking-tight text-slate-900">{title}</h2>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden px-16 pb-4 pt-7">
        <div ref={innerRef} style={{ zoom: fit }}>{children}</div>
      </div>
      <Footer ctx={ctx} />
    </div>
  );
}

function Footer({ ctx, dark }: { ctx: Ctx; dark?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-16 pb-6 text-[15px] ${dark ? "text-white/70" : "text-slate-400"}`}>
      <span>{ctx.orgName ?? "Training"}</span>
      <span className="tabular-nums">{ctx.index + 1} / {ctx.total}</span>
    </div>
  );
}

function RolePill({ role, ctx }: { role: string; ctx: Ctx }) {
  const system = role === "system";
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-4 py-1.5 text-[16px] font-semibold"
      style={system
        ? { background: "#eef2f7", color: "#475569", border: "1.5px dashed #94a3b8" }
        : { background: BRAND, color: "var(--brand-fg, #fff)" }}
    >
      {system ? "Automatic" : ctx.roleName(role)}
    </span>
  );
}

function CoverSlide({ ctx }: { ctx: Ctx }) {
  return (
    <div className="relative flex h-full w-full flex-col justify-between overflow-hidden text-white" style={{ background: BRAND }}>
      <div className="absolute -right-40 -top-40 size-[560px] rounded-full opacity-25" style={{ background: ACCENT }} />
      <div className="absolute -bottom-56 right-40 size-[420px] rounded-full bg-white/10" />
      <div className="relative px-20 pt-20">
        <p className="text-[22px] font-semibold uppercase tracking-[0.2em] text-white/80">{ctx.orgName ?? "Training"}</p>
      </div>
      <div className="relative px-20">
        <h1 className="max-w-[900px] text-[76px] font-bold leading-[1.05] tracking-tight">Training handbook</h1>
        <div className="mt-6 h-1.5 w-28 rounded-full" style={{ background: ACCENT }} />
        <p className="mt-6 text-[28px] text-white/90">
          {ctx.audience ? `For the ${ctx.audience}` : "Every role, every journey"}
          {" · "}{ctx.processes.length} {ctx.processes.length === 1 ? "process" : "processes"}
        </p>
      </div>
      <div className="relative flex items-center justify-between px-20 pb-12 text-[18px] text-white/70">
        <span>{ctx.trainerView ? "Trainer edition" : "Team edition"}</span>
        <span>{new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
      </div>
    </div>
  );
}

function AgendaSlide({ ctx }: { ctx: Ctx }) {
  const modules: string[] = [];
  const counts = new Map<string, number>();
  for (const p of ctx.processes) {
    if (!counts.has(p.module)) { modules.push(p.module); counts.set(p.module, 0); }
    counts.set(p.module, counts.get(p.module)! + 1);
  }
  // Two columns past six modules, and a tighter row past twelve, so the whole
  // agenda always fits one slide.
  const twoCols = modules.length > 6;
  const dense = modules.length > 12;
  return (
    <Frame ctx={ctx} kicker="Agenda" title="What this session covers">
      <ol className={`grid gap-x-12 ${dense ? "gap-y-1.5" : "gap-y-3"} ${twoCols ? "grid-cols-2" : "grid-cols-1"}`}>
        {modules.map((m, i) => (
          <li key={m} className={`flex items-center gap-5 border-b border-slate-200 ${dense ? "pb-1.5" : "pb-3"}`}>
            <span className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white ${dense ? "size-9 text-[16px]" : "size-11 text-[19px]"}`} style={{ background: BRAND }}>
              {i + 1}
            </span>
            <span className={`flex-1 font-medium ${dense ? "text-[21px]" : "text-[24px]"}`}>{m}</span>
            <span className="text-[17px] text-slate-500">
              {counts.get(m)} {counts.get(m) === 1 ? "process" : "processes"}
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

function SectionSlide({ slide, ctx }: { slide: Extract<Slide, { kind: "section" }>; ctx: Ctx }) {
  const titles = ctx.processes.filter((p) => p.module === slide.module).map((p) => p.title);
  return (
    <div className="flex h-full w-full bg-white text-slate-900">
      <div className="flex w-[420px] shrink-0 flex-col justify-center px-16 text-white" style={{ background: BRAND }}>
        <p className="text-[20px] font-semibold uppercase tracking-[0.2em] text-white/75">Module</p>
        <p className="text-[150px] font-bold leading-none">{String(slide.number).padStart(2, "0")}</p>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col justify-center px-16">
          <h2 className="text-[60px] font-bold leading-[1.1] tracking-tight">{slide.module}</h2>
          <div className="mt-5 h-1.5 w-24 rounded-full" style={{ background: ACCENT }} />
          <ul className="mt-8 space-y-3 text-[23px] text-slate-600">
            {titles.slice(0, 6).map((t) => <li key={t}>· {t}</li>)}
            {titles.length > 6 && <li className="text-slate-400">and {titles.length - 6} more</li>}
          </ul>
        </div>
        <Footer ctx={ctx} />
      </div>
    </div>
  );
}

function OverviewSlide({ process, ctx }: { process: Process; ctx: Ctx }) {
  const people = Array.from(new Set(process.steps.map((s) => s.role)));
  return (
    <Frame ctx={ctx} kicker={process.module} title={process.title}>
      <div className="grid h-full grid-cols-[1fr_400px] gap-10">
        <div className="space-y-7">
          <div>
            <p className="text-[17px] font-semibold uppercase tracking-wider text-slate-500">Starts when</p>
            <p className="mt-2 text-[24px] leading-snug text-slate-800">{process.startsWhen}</p>
          </div>
          <div className="rounded-xl border-l-[6px] px-6 py-5" style={{ borderColor: "#15803d", background: "#f0fdf4" }}>
            <p className="text-[17px] font-semibold uppercase tracking-wider text-green-800">Done means</p>
            <p className="mt-2 text-[21px] leading-snug text-slate-800">{process.doneMeans}</p>
          </div>
        </div>
        <div className="rounded-xl bg-slate-50 px-6 py-5">
          <p className="text-[17px] font-semibold uppercase tracking-wider text-slate-500">Who takes part</p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {people.map((r) => <RolePill key={r} role={r} ctx={ctx} />)}
          </div>
          <p className="mt-6 text-[17px] text-slate-500">
            {process.steps.length} steps
            {process.refusals?.length ? ` · ${process.refusals.length} things it refuses` : ""}
          </p>
        </div>
      </div>
    </Frame>
  );
}

function StepsSlide({ slide, ctx }: { slide: Extract<Slide, { kind: "steps" }>; ctx: Ctx }) {
  const suffix = slide.pages > 1 ? ` (${slide.page} of ${slide.pages})` : "";
  return (
    <Frame ctx={ctx} kicker={`${slide.process.module} · How it runs${suffix}`} title={slide.process.title}>
      <ol className="relative space-y-5">
        <div className="absolute bottom-6 left-[27px] top-6 w-[3px] rounded-full bg-slate-200" aria-hidden />
        {slide.steps.map(({ n, step }) => (
          <li key={n} className="relative flex gap-6">
            <span
              className="relative z-[1] flex size-14 shrink-0 items-center justify-center rounded-full text-[22px] font-bold"
              style={step.role === "system"
                ? { background: "#fff", color: "#475569", border: "3px dashed #94a3b8" }
                : { background: BRAND, color: "var(--brand-fg, #fff)" }}
            >
              {n}
            </span>
            <div className="min-w-0 flex-1 pt-1.5">
              <RolePill role={step.role} ctx={ctx} />
              <p className="mt-2 text-[20px] leading-snug text-slate-800">{step.action}</p>
            </div>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

function RefusalsSlide({ slide, ctx }: { slide: Extract<Slide, { kind: "refusals" }>; ctx: Ctx }) {
  const suffix = slide.pages > 1 ? ` (${slide.page} of ${slide.pages})` : "";
  return (
    <Frame ctx={ctx} kicker={`${slide.process.module} · When the system says no${suffix}`} title={slide.process.title}>
      <div className="space-y-4">
        {slide.refusals.map((r, i) => (
          <div key={i} className="rounded-xl border-l-[6px] px-6 py-4" style={{ borderColor: "#b45309", background: "#fffbeb" }}>
            <p className="text-[21px] font-semibold leading-snug text-amber-900">{r.trigger}</p>
            <p className="mt-1.5 text-[19px] leading-snug text-slate-700">{r.explanation}</p>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function PracticeSlide({ process, ctx }: { process: Process; ctx: Ctx }) {
  return (
    <div className="flex h-full w-full flex-col text-white" style={{ background: BRAND }}>
      <div className="flex flex-1 flex-col justify-center px-20">
        <p className="text-[20px] font-semibold uppercase tracking-[0.2em] text-white/75">Your turn · {process.module}</p>
        <h2 className="mt-3 text-[46px] font-bold leading-[1.1] tracking-tight">{process.title}</h2>
        <div className="mt-5 h-1.5 w-24 rounded-full" style={{ background: ACCENT }} />
        <p className="mt-8 max-w-[1050px] text-[30px] leading-snug text-white/95">{process.trainer.exercise}</p>
        <p className="mt-8 text-[18px] text-white/70">Practise on the demo organisation, never a live one.</p>
      </div>
      <Footer ctx={ctx} dark />
    </div>
  );
}

function EndSlide({ ctx }: { ctx: Ctx }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center text-center text-white" style={{ background: BRAND }}>
      <p className="text-[24px] font-semibold uppercase tracking-[0.2em] text-white/75">{ctx.orgName ?? "Training"}</p>
      <h2 className="mt-4 text-[72px] font-bold tracking-tight">Questions?</h2>
      <div className="mt-6 h-1.5 w-28 rounded-full" style={{ background: ACCENT }} />
      <p className="mt-8 max-w-[900px] text-[26px] text-white/85">
        Your own role guide is under Guide on the main menu, and the full handbook downloads from Training.
      </p>
    </div>
  );
}
