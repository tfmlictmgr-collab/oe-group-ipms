"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronRight, ChevronDown, Plus, Pencil, Archive, Users, Building,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runAction, describeError } from "@/lib/run-action";
import { createNode, renameNode, retireNode, setNodeStakeholder } from "./actions";

export type Node = {
  id: string;
  parent_id: string | null;
  level: "region" | "location" | "project" | "site";
  name: string;
  code: string | null;
  child_count: number;
  direct_property_count: number;
  subtree_property_count: number;
};

export type Manager = { id: string; name: string };

// REGION → LOCATION → PROJECT → SITE (0087). A project happens in a place.
const NEXT_LEVEL: Record<Node["level"], Node["level"] | null> = {
  region: "location", location: "project", project: "site", site: null,
};
const LEVEL_LABEL: Record<Node["level"], string> = {
  region: "Region", location: "Location", project: "Project", site: "Site",
};

type Panel = { nodeId: string; mode: "add" | "rename" | "managers" } | null;

/**
 * REGION → PROJECT → LOCATION → SITE (0066), the first screen that lets
 * anyone see or shape it rather than reaching for database access. A property
 * hangs off a SITE and only a site — so "Site" rows carry a link into the
 * property list instead of an "add child" action.
 */
export default function HierarchyTree({
  nodes,
  managers,
  assignments,
  canWrite,
}: {
  nodes: Node[];
  managers: Manager[];
  assignments: { node_id: string; user_id: string }[];
  canWrite: boolean;
}) {
  const [panel, setPanel] = React.useState<Panel>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(nodes.filter((n) => n.level === "region").map((n) => n.id))
  );

  const byParent = React.useMemo(() => {
    const m = new Map<string, Node[]>();
    for (const n of nodes) {
      const key = n.parent_id ?? "__root__";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(n);
    }
    m.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
    return m;
  }, [nodes]);

  const roots = byParent.get("__root__") ?? [];

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (roots.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          No regions yet. Everything else in the tree hangs off one.
        </p>
        {canWrite && <AddForm parentId={null} level="region" onClose={() => setPanel(null)} open />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {roots.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            depth={0}
            byParent={byParent}
            expanded={expanded}
            onToggle={toggle}
            panel={panel}
            setPanel={setPanel}
            managers={managers}
            assignments={assignments}
            canWrite={canWrite}
          />
        ))}
      </ul>
      {canWrite && (
        panel?.nodeId === "__root__" && panel.mode === "add" ? (
          <AddForm parentId={null} level="region" onClose={() => setPanel(null)} open />
        ) : (
          <Button
            type="button" variant="outline" size="sm"
            onClick={() => setPanel({ nodeId: "__root__", mode: "add" })}
          >
            <Plus /> Add region
          </Button>
        )
      )}
    </div>
  );
}

function NodeRow({
  node, depth, byParent, expanded, onToggle, panel, setPanel, managers, assignments, canWrite,
}: {
  node: Node;
  depth: number;
  byParent: Map<string, Node[]>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  managers: Manager[];
  assignments: { node_id: string; user_id: string }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const children = byParent.get(node.id) ?? [];
  const isOpen = expanded.has(node.id);
  const nextLevel = NEXT_LEVEL[node.level];
  const nodeManagers = managers.filter((m) =>
    assignments.some((a) => a.node_id === node.id && a.user_id === m.id)
  );

  async function retire() {
    setBusy(true);
    try {
      await runAction(retireNode(node.id));
      toast.success(`${node.name} retired`);
      router.refresh();
    } catch (err) {
      toast.error("Could not retire that", { description: describeError(err), duration: Infinity, closeButton: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-accent/40"
        style={{ paddingLeft: `${depth * 1.5}rem` }}
      >
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          disabled={children.length === 0}
          className="flex size-5 flex-shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
        >
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <Badge variant="outline" className="flex-shrink-0 text-[10px] uppercase tracking-wide">
          {LEVEL_LABEL[node.level]}
        </Badge>

        <span className="min-w-0 truncate text-sm font-medium">{node.name}</span>
        {node.code && <span className="flex-shrink-0 text-xs text-muted-foreground">({node.code})</span>}

        {nodeManagers.length > 0 && (
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            <Users className="mr-1 inline size-3" />
            {nodeManagers.map((m) => m.name).join(", ")}
          </span>
        )}

        {node.level === "site" ? (
          node.direct_property_count > 0 && (
            <Link
              href="/dashboard/properties"
              className="flex-shrink-0 text-xs text-brand hover:underline"
            >
              {node.direct_property_count} propert{node.direct_property_count === 1 ? "y" : "ies"}
            </Link>
          )
        ) : (
          node.subtree_property_count > 0 && (
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              <Building className="mr-1 inline size-3" />
              {node.subtree_property_count} in this {node.level}
            </span>
          )
        )}

        {canWrite && (
          <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
            {nextLevel && (
              <Button
                type="button" size="icon-sm" variant="ghost" title={`Add a ${nextLevel} here`}
                onClick={() => setPanel(panel?.nodeId === node.id && panel.mode === "add" ? null : { nodeId: node.id, mode: "add" })}
              >
                <Plus />
              </Button>
            )}
            <Button
              type="button" size="icon-sm" variant="ghost" title="Rename"
              onClick={() => setPanel(panel?.nodeId === node.id && panel.mode === "rename" ? null : { nodeId: node.id, mode: "rename" })}
            >
              <Pencil />
            </Button>
            <Button
              type="button" size="icon-sm" variant="ghost" title="Regional managers assigned here"
              onClick={() => setPanel(panel?.nodeId === node.id && panel.mode === "managers" ? null : { nodeId: node.id, mode: "managers" })}
            >
              <Users />
            </Button>
            <Button
              type="button" size="icon-sm" variant="ghost" title="Retire" disabled={busy}
              onClick={retire}
            >
              <Archive />
            </Button>
          </div>
        )}
      </div>

      {canWrite && panel?.nodeId === node.id && panel.mode === "add" && nextLevel && (
        <div style={{ paddingLeft: `${(depth + 1) * 1.5}rem` }} className="pb-2 pr-2">
          <AddForm parentId={node.id} level={nextLevel} onClose={() => setPanel(null)} open />
        </div>
      )}
      {canWrite && panel?.nodeId === node.id && panel.mode === "rename" && (
        <div style={{ paddingLeft: `${(depth + 1) * 1.5}rem` }} className="pb-2 pr-2">
          <RenameForm node={node} onClose={() => setPanel(null)} />
        </div>
      )}
      {canWrite && panel?.nodeId === node.id && panel.mode === "managers" && (
        <div style={{ paddingLeft: `${(depth + 1) * 1.5}rem` }} className="pb-2 pr-2">
          <ManagerPanel node={node} managers={managers} assigned={nodeManagers.map((m) => m.id)} />
        </div>
      )}

      {isOpen && children.length > 0 && (
        <ul className="space-y-1">
          {children.map((c) => (
            <NodeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              byParent={byParent}
              expanded={expanded}
              onToggle={onToggle}
              panel={panel}
              setPanel={setPanel}
              managers={managers}
              assignments={assignments}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddForm({
  parentId, level, onClose, open,
}: {
  parentId: string | null; level: Node["level"]; onClose: () => void; open: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await runAction(createNode(parentId, level, name, code));
      toast.success(`${name} added`);
      setName(""); setCode("");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(`Could not add that ${level}`, { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2">
      <Input
        autoFocus value={name} onChange={(e) => setName(e.target.value)}
        placeholder={`New ${LEVEL_LABEL[level].toLowerCase()} name`}
        className="h-8 max-w-[220px] text-sm"
      />
      <Input
        value={code} onChange={(e) => setCode(e.target.value)}
        placeholder="Code (optional)"
        className="h-8 max-w-[140px] text-sm"
      />
      <Button type="submit" size="sm" variant="brand" disabled={busy || name.trim().length < 2}>
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
    </form>
  );
}

function RenameForm({ node, onClose }: { node: Node; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(node.name);
  const [code, setCode] = React.useState(node.code ?? "");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await runAction(renameNode(node.id, name, code));
      toast.success("Renamed");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error("Could not rename that", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-w-[220px] text-sm" />
      <Input
        value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (optional)"
        className="h-8 max-w-[140px] text-sm"
      />
      <Button type="submit" size="sm" variant="brand" disabled={busy || name.trim().length < 2}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
    </form>
  );
}

function ManagerPanel({
  node, managers, assigned,
}: {
  node: Node; managers: Manager[]; assigned: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function toggle(m: Manager) {
    setBusy(m.id);
    try {
      const next = !assigned.includes(m.id);
      await runAction(setNodeStakeholder(node.id, m.id, next));
      toast.success(
        next ? `${m.name} now manages this ${node.level}` : `${m.name} removed from this ${node.level}`,
        { description: next ? "They can reach every property beneath it, including ones filed later." : undefined }
      );
      router.refresh();
    } catch (err) {
      toast.error("Could not change that", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  if (managers.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
        No regional managers to assign yet — invite one under People first.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 rounded-md border border-dashed border-border p-2">
      {managers.map((m) => {
        const on = assigned.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            disabled={busy === m.id}
            onClick={() => toggle(m)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              on
                ? "border-transparent bg-[var(--brand)] text-[var(--brand-fg)]"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
              busy === m.id && "cursor-not-allowed opacity-60"
            )}
          >
            {m.name}
          </button>
        );
      })}
    </div>
  );
}
