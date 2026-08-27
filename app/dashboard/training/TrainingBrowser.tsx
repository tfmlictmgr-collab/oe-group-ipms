"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, ChevronDown, ChevronUp, Download, Presentation } from "lucide-react";
import type { Process } from "@/lib/guides/processes";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PresentMode from "./PresentMode";

type RoleOption = { key: string; label: string };

// The handbook itself: every process in this edition, filterable by role and
// by free text, rendered either as a Trainer view (with demo notes, common
// mistakes and a practice exercise) or a Team view (steps only) — the same
// choice `content.ts` already makes between what a role needs and what a
// trainer needs, applied at the level of a whole journey instead of one role.
//
// A step whose role is "system" is shown as an automated step, never folded
// into a human's — decision 10 requires automation's part in a journey to be
// stated, not quietly attributed to whoever clicks next.
export default function TrainingBrowser({
  processes,
  roles,
}: {
  processes: Process[];
  roles: RoleOption[];
}) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [trainerView, setTrainerView] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // `?present=1` is a deep link into slide mode for a screen-share invite —
  // read once on mount, never re-derived, so leaving present mode does not
  // immediately re-trigger it from the still-present query string.
  const [presenting, setPresenting] = useState(() => searchParams.get("present") === "1");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return processes.filter((p) => {
      if (roleFilter !== "all" && !p.roles.includes(roleFilter)) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.module.toLowerCase().includes(q) ||
        p.startsWhen.toLowerCase().includes(q)
      );
    });
  }, [processes, query, roleFilter]);

  const grouped = useMemo(() => {
    const byModule = new Map<string, Process[]>();
    for (const p of filtered) {
      if (!byModule.has(p.module)) byModule.set(p.module, []);
      byModule.get(p.module)!.push(p);
    }
    return byModule;
  }, [filtered]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const roleName = (key: string) =>
    key === "system" ? "Automatic" : roles.find((r) => r.key === key)?.label ?? key;

  if (presenting) {
    return (
      <PresentMode
        processes={filtered}
        roleName={roleName}
        trainerView={trainerView}
        startAt={searchParams.get("process") ?? undefined}
        onExit={() => setPresenting(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a process…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={trainerView ? "brand" : "outline"}
            size="sm"
            onClick={() => setTrainerView(true)}
          >
            Trainer view
          </Button>
          <Button
            type="button"
            variant={!trainerView ? "brand" : "outline"}
            size="sm"
            onClick={() => setTrainerView(false)}
          >
            Team view
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={filtered.length === 0}
            onClick={() => setPresenting(true)}
          >
            <Presentation className="size-4" /> Present
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={roleFilter === "all" ? "secondary" : "ghost"}
          onClick={() => setRoleFilter("all")}
        >
          Every role
        </Button>
        {roles.map((r) => (
          <Button
            key={r.key}
            type="button"
            size="sm"
            variant={roleFilter === r.key ? "secondary" : "ghost"}
            onClick={() => setRoleFilter(r.key)}
          >
            {r.label}
          </Button>
        ))}
        {roleFilter !== "all" && (
          <Button asChild size="sm" variant="outline" className="ml-1">
            <a
              href={`/api/training?scope=role&role=${encodeURIComponent(roleFilter)}${trainerView ? "" : "&view=team"}`}
              download
            >
              <Download className="size-4" /> Download this chapter
            </a>
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches that search.</p>
      ) : (
        Array.from(grouped.entries()).map(([module, items]) => (
          <section key={module} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {module}
            </h2>
            <div className="space-y-3">
              {items.map((p) => {
                const isOpen = open.has(p.id) || items.length === 1;
                return (
                  <Card key={p.id} id={p.id}>
                    <CardHeader
                      className="cursor-pointer select-none pb-3"
                      onClick={() => toggle(p.id)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <CardTitle className="text-base">{p.title}</CardTitle>
                          <CardDescription>{p.startsWhen}</CardDescription>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {p.requiresFeature && (
                            <Badge variant="info">{p.requiresFeature}</Badge>
                          )}
                          {p.operatorOnly && <Badge variant="muted">Operator only</Badge>}
                          {isOpen ? (
                            <ChevronUp className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    {isOpen && (
                      <CardContent className="space-y-4 pt-0">
                        <ol className="space-y-2">
                          {p.steps.map((step, i) => (
                            <li key={i} className="flex gap-3 text-sm">
                              <Badge
                                variant={step.role === "system" ? "outline" : "default"}
                                className="mt-0.5 shrink-0"
                              >
                                {roleName(step.role)}
                              </Badge>
                              <span>{step.action}</span>
                            </li>
                          ))}
                        </ol>

                        <div className="rounded-md bg-success/10 px-3 py-2 text-sm">
                          <span className="font-medium text-success-onTint">Done means: </span>
                          {p.doneMeans}
                        </div>

                        {p.refusals && p.refusals.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Common refusals — the control working, not a fault
                            </p>
                            {p.refusals.map((r, i) => (
                              <div key={i} className="rounded-md bg-warning/10 px-3 py-2 text-sm">
                                <p className="font-medium text-warning-onTint">{r.trigger}</p>
                                <p className="text-muted-foreground">{r.explanation}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {trainerView && (
                          <div className="space-y-2 border-t border-border pt-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              For the trainer
                            </p>
                            <p className="text-sm">
                              <span className="font-medium">Demo: </span>
                              {p.trainer.demo}
                            </p>
                            {p.trainer.commonMistake && (
                              <p className="text-sm">
                                <span className="font-medium">Common mistake: </span>
                                {p.trainer.commonMistake}
                              </p>
                            )}
                            <p className="text-sm">
                              <span className="font-medium">Practice exercise: </span>
                              {p.trainer.exercise}
                            </p>
                          </div>
                        )}

                        <div className="flex justify-end border-t border-border pt-3">
                          <Button asChild size="sm" variant="ghost">
                            <a
                              href={`/api/training?scope=process&id=${encodeURIComponent(p.id)}${trainerView ? "" : "&view=team"}`}
                              download
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Download className="size-4" /> Download as a job aid
                            </a>
                          </Button>
                        </div>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
