"use client";

import * as React from "react";
import { Plus, Check, X } from "lucide-react";
import { Select, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export type OrgNode = {
  id: string;
  parent_id: string | null;
  level: "region" | "location" | "project" | "site";
  name: string;
};

// REGION → LOCATION → PROJECT → SITE (0087). A project happens in a place, not
// the other way round — which is why LOCATION sits above PROJECT and a manager
// can name Kano without first inventing a scheme to put it in.
const LEVELS = ["region", "location", "project", "site"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_LABEL: Record<Level, string> = {
  region: "Region", location: "Location", project: "Project", site: "Site",
};
const LEVEL_HINT: Record<Level, string> = {
  region: "North, South or East",
  location: "The city or town — Kano, Lagos, Port Harcourt",
  project: "The development or contract, e.g. Kano Housing Scheme",
  site: "The specific estate or compound the property sits on",
};

/**
 * Four cascading selects over the hierarchy, with inline creation.
 *
 * ⚠️ The inline creation is not a nicety. Without it the picker was a dead end:
 * a manager adding the first property in a new city picked a Region, found
 * Location empty and disabled, and had no way forward without leaving the form,
 * going to Regions & sites, building the branch, and starting again. That was
 * reported from a live screen — "the other fields cannot be selected even after
 * picking the set default regions."
 *
 * Two shapes, one component:
 *   `stopAtLevel="site"` — only a complete chain down to a SITE produces a
 *   value, because 0066's trigger refuses a property filed above a site.
 *   `stopAtLevel="any"` — picking at any level finalises immediately, for
 *   scoping a regional manager who may administer a whole region or one site.
 */
export default function HierarchyPicker({
  nodes,
  value,
  onChange,
  stopAtLevel,
  onCreate,
}: {
  nodes: OrgNode[];
  value: string;
  onChange: (nodeId: string) => void;
  stopAtLevel: "site" | "any";
  /**
   * Creates a node and returns its id. When omitted the picker is
   * selection-only — used where the caller has no right to reshape the tree.
   */
  onCreate?: (parentId: string, level: Level, name: string) => Promise<string>;
}) {
  const [pool, setPool] = React.useState<OrgNode[]>(nodes);
  React.useEffect(() => { setPool(nodes); }, [nodes]);

  const byId = React.useMemo(() => new Map(pool.map((n) => [n.id, n])), [pool]);

  // Walk a preselected value back up to its ancestors so the selects agree with
  // each other on first render (editing something already filed).
  const ancestry = React.useMemo(() => {
    const chain: Record<string, string> = {};
    let cur = value ? byId.get(value) : undefined;
    while (cur) {
      chain[cur.level] = cur.id;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
    // Only on the initial value — re-deriving on every pool change would fight
    // the user's own selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const [selected, setSelected] = React.useState<Record<string, string>>(ancestry);
  const [adding, setAdding] = React.useState<Level | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const parentOf = (level: Level) => {
    const i = LEVELS.indexOf(level);
    return i === 0 ? null : selected[LEVELS[i - 1]] ?? null;
  };

  const optionsFor = (level: Level) => {
    const parentId = parentOf(level);
    if (level !== "region" && !parentId) return [];
    return pool
      .filter((n) => n.level === level && (level === "region" ? n.parent_id === null : n.parent_id === parentId))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  function commit(next: Record<string, string>) {
    setSelected(next);
    if (stopAtLevel === "any") {
      // The deepest thing actually chosen.
      for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (next[LEVELS[i]]) return onChange(next[LEVELS[i]]);
      }
      onChange("");
    } else {
      onChange(next.site ?? "");
    }
  }

  function pick(level: Level, id: string) {
    // Choosing higher up clears everything beneath — a Site must never survive
    // under a Region it no longer belongs to.
    const idx = LEVELS.indexOf(level);
    const next: Record<string, string> = {};
    for (let i = 0; i < idx; i++) next[LEVELS[i]] = selected[LEVELS[i]];
    if (id) next[level] = id;
    commit(next);
  }

  async function create(level: Level) {
    const parentId = parentOf(level);
    if (!onCreate || !parentId || draft.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const id = await onCreate(parentId, level, draft.trim());
      const created: OrgNode = { id, parent_id: parentId, level, name: draft.trim() };
      setPool((p) => [...p, created]);
      const idx = LEVELS.indexOf(level);
      const next: Record<string, string> = {};
      for (let i = 0; i < idx; i++) next[LEVELS[i]] = selected[LEVELS[i]];
      next[level] = id;
      commit(next);
      setAdding(null);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that.");
    } finally {
      setBusy(false);
    }
  }

  if (pool.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No regional structure set up yet — an administrator adds one under
        Properties → Regions &amp; sites.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-4">
        {LEVELS.map((level) => {
          const options = optionsFor(level);
          const parentId = parentOf(level);
          const locked = level !== "region" && !parentId;
          const canAdd = Boolean(onCreate) && !locked && level !== "region";

          return (
            <div key={level} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`node-${level}`}>{LEVEL_LABEL[level]}</Label>
                {canAdd && adding !== level && (
                  <button
                    type="button"
                    onClick={() => { setAdding(level); setDraft(""); setError(null); }}
                    className="text-xs text-brand hover:underline"
                  >
                    <Plus className="mr-0.5 inline size-3" />New
                  </button>
                )}
              </div>

              {adding === level ? (
                <div className="flex gap-1">
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); create(level); }
                      if (e.key === "Escape") { setAdding(null); setDraft(""); }
                    }}
                    placeholder={`New ${LEVEL_LABEL[level].toLowerCase()}`}
                    className="h-9 text-sm"
                    disabled={busy}
                  />
                  <Button
                    type="button" size="icon-sm" variant="brand"
                    disabled={busy || draft.trim().length < 2}
                    onClick={() => create(level)}
                    title={`Add this ${level}`}
                  >
                    <Check />
                  </Button>
                  <Button
                    type="button" size="icon-sm" variant="ghost"
                    onClick={() => { setAdding(null); setDraft(""); setError(null); }}
                    title="Cancel"
                  >
                    <X />
                  </Button>
                </div>
              ) : (
                <Select
                  id={`node-${level}`}
                  value={selected[level] ?? ""}
                  disabled={locked}
                  onChange={(e) => pick(level, e.target.value)}
                >
                  <option value="">
                    {locked
                      ? `Choose a ${LEVEL_LABEL[LEVELS[LEVELS.indexOf(level) - 1]].toLowerCase()} first`
                      : options.length === 0
                        ? canAdd ? "None yet — add one" : "None"
                        : stopAtLevel === "any" ? "Stop here" : "Not filed"}
                  </option>
                  {options.map((n) => (
                    <option key={n.id} value={n.id}>{n.name}</option>
                  ))}
                </Select>
              )}

              <p className="text-[11px] leading-tight text-muted-foreground">
                {LEVEL_HINT[level]}
              </p>
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
