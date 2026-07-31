"use client";

import * as React from "react";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type OrgNode = {
  id: string;
  parent_id: string | null;
  level: "region" | "project" | "location" | "site";
  name: string;
};

const LEVELS = ["region", "project", "location", "site"] as const;
const LEVEL_LABEL: Record<(typeof LEVELS)[number], string> = {
  region: "Region", project: "Project", location: "Location", site: "Site",
};

/**
 * Four cascading selects over the REGION → PROJECT → LOCATION → SITE tree
 * (0066), resolved client-side against the whole tree fetched once — the
 * portfolio is small enough that this beats a round trip per level.
 *
 * Two shapes, one component:
 *   `stopAtLevel="site"` — only a complete Region→Site chain produces a
 *   value. This is how a PROPERTY is filed: 0066's own trigger refuses
 *   anything filed above a site, so a half-made selection should not submit
 *   as one either.
 *   `stopAtLevel="any"` — picking a node at ANY level finalises the value
 *   immediately, and the levels below it stay open to narrow further. This is
 *   how a REGIONAL MANAGER is scoped: they may administer a whole region, one
 *   project inside it, or drill all the way to a single site — the schema
 *   accepts a node_id at any level, and the picker should not force a depth
 *   the assignment doesn't need.
 */
export default function HierarchyPicker({
  nodes, value, onChange, stopAtLevel,
}: {
  nodes: OrgNode[];
  value: string;
  onChange: (nodeId: string) => void;
  stopAtLevel: "site" | "any";
}) {
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const ancestry = React.useMemo(() => {
    const chain: Record<string, string> = {};
    let cur = value ? byId.get(value) : undefined;
    while (cur) {
      chain[cur.level] = cur.id;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  }, [value, byId]);

  const [selected, setSelected] = React.useState<Record<string, string>>(ancestry);

  const optionsFor = (level: (typeof LEVELS)[number]) => {
    const parentLevel = LEVELS[LEVELS.indexOf(level) - 1];
    const parentId = parentLevel ? selected[parentLevel] : undefined;
    if (level !== "region" && !parentId) return [];
    return nodes
      .filter((n) => n.level === level && (level === "region" ? n.parent_id === null : n.parent_id === parentId))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  function pick(level: (typeof LEVELS)[number], id: string) {
    const idx = LEVELS.indexOf(level);
    const next: Record<string, string> = {};
    for (let i = 0; i < idx; i++) next[LEVELS[i]] = selected[LEVELS[i]];
    if (id) next[level] = id;
    setSelected(next);

    if (stopAtLevel === "any") {
      onChange(id || next[LEVELS[idx - 1]] || "");
    } else {
      onChange(next.site ?? "");
    }
  }

  if (nodes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No regional structure set up yet — an administrator adds one under
        Properties → Regions &amp; sites.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {LEVELS.map((level) => {
        const options = optionsFor(level);
        const disabled = level !== "region" && !selected[LEVELS[LEVELS.indexOf(level) - 1]];
        return (
          <div key={level} className="space-y-1.5">
            <Label htmlFor={`node-${level}`}>{LEVEL_LABEL[level]}</Label>
            <Select
              id={`node-${level}`}
              value={selected[level] ?? ""}
              disabled={disabled || options.length === 0}
              onChange={(e) => pick(level, e.target.value)}
            >
              <option value="">
                {disabled ? "—" : options.length === 0 ? "None" : stopAtLevel === "any" ? "Stop here" : "Not filed"}
              </option>
              {options.map((n) => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </Select>
          </div>
        );
      })}
    </div>
  );
}
