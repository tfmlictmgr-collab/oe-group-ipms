"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { runAction, describeError } from "@/lib/run-action";
import { setPropertyStakeholder } from "../actions";

type Candidate = { id: string; name: string; email?: string | null; role: string; roleName: string };

export default function StakeholderPanel({
  propertyId, brand, candidates, attached, canWrite, opensProfiles = false,
}: {
  propertyId: string;
  brand: string | null;
  candidates: Candidate[];
  attached: { userId: string; relation: "manager" | "owner" }[];
  canWrite: boolean;
  opensProfiles?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [attachedOnly, setAttachedOnly] = React.useState(false);

  const isAttached = (userId: string, relation: "manager" | "owner") =>
    attached.some((a) => a.userId === userId && a.relation === relation);
  const relationOf = (c: Candidate) => (c.role === "property_owner" ? "owner" : "manager");

  // Asked for directly (11 Sept 2026): every manager and owner in the org is a
  // candidate here, so on a real portfolio the list runs to dozens and the one
  // person you came to attach is a scroll away. Searched in the browser — the
  // server already chose the candidates; a search only ever narrows them.
  // The relation ("owner" / "manager") is searchable too, because that is the
  // word on the row a person is reading.
  const visible = React.useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return candidates.filter((c) => {
      if (attachedOnly && !isAttached(c.id, relationOf(c))) return false;
      if (words.length === 0) return true;
      const hay = [c.name, c.email, c.roleName, relationOf(c)].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, attached, query, attachedOnly]);
  const attachedCount = candidates.filter((c) => isAttached(c.id, relationOf(c))).length;

  async function toggle(c: Candidate, relation: "manager" | "owner") {
    const key = `${c.id}:${relation}`;
    setBusy(key);
    try {
      const next = !isAttached(c.id, relation);
      await runAction(setPropertyStakeholder(propertyId, c.id, relation, next));
      toast.success(
        next ? `${c.name} attached to this property` : `${c.name} detached`,
        { description: next ? "They can now see and act on it." : "Their access to it is removed." }
      );
      router.refresh();
    } catch (e) {
      toast.error("Could not change that", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No one to attach yet — invite a {brand === "OEA" ? "properties manager" : "facilities manager"} or
        a property owner under People first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 pb-1">
        <div className="relative w-full sm:w-auto sm:min-w-0 sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, role or email…"
            aria-label="Search people who can be attached"
            className="pl-9"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={attachedOnly}
            onChange={(e) => setAttachedOnly(e.target.checked)}
            className="size-4 rounded border-input"
          />
          Attached only ({attachedCount})
        </label>
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {visible.length} of {candidates.length}
        </span>
      </div>

      {visible.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {attachedOnly && !query.trim()
            ? "Nobody is attached to this property yet."
            : "Nobody matches that search."}
        </p>
      )}

      {visible.map((c) => {
        const relation = relationOf(c);
        const on = isAttached(c.id, relation);
        const key = `${c.id}:${relation}`;
        return (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {opensProfiles ? (
                  <Link href={`/dashboard/people/${c.id}`} className="underline-offset-2 hover:underline">
                    {c.name}
                  </Link>
                ) : (
                  c.name
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {c.roleName}
                {c.email && ` · ${c.email}`}
                {" · "}
                {on ? `attached as ${relation}` : `would be attached as ${relation}`}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`Attach ${c.name} to this property`}
              disabled={!canWrite || busy === key}
              onClick={() => toggle(c, relation)}
              className={cn(
                "relative h-5 w-9 flex-shrink-0 rounded-full transition-colors",
                on ? "bg-[var(--brand)]" : "bg-muted",
                (!canWrite || busy === key) && "cursor-not-allowed opacity-60"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                  on ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </button>
          </div>
        );
      })}
      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          Read-only — changing attachments needs the portfolio management permission.
        </p>
      )}
    </div>
  );
}
