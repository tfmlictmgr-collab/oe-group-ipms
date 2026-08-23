"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, RotateCcw, ShieldCheck, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { roleLabel, FM_PM } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { runAction, describeError } from "@/lib/run-action";
import { setPermission, resetToB7, type MatrixView } from "./actions";

// ⚠️ Every role the matrix governs must appear here, or it is governed in the
// dark. `executive` and `regional_manager` were added to `user_role` (0071) and
// given real seeded rows by `seed_b7_permissions` (0072b, revised 0077) — but
// were never added to this list, so the two newest roles were the only ones an
// administrator could not see or adjust. A permission an operator cannot read
// is not a governed permission; it is a default nobody has reviewed.
//
// Ordered roughly by seniority so the matrix reads the way the org does.
const ROLES = [
  "tenant", "vendor", "fm_ops_staff", ...FM_PM,
  "regional_manager", "finance_approver", "property_owner", "viewer",
  "executive", "admin",
] as const;

export default function MatrixEditor({
  view,
  brand,
  currentOrgId,
}: {
  view: MatrixView;
  brand: string | null;
  currentOrgId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [orgId, setOrgId] = React.useState(currentOrgId);

  const granted = React.useMemo(() => {
    const m = new Set<string>();
    for (const r of view.rows) if (r.granted) m.add(`${r.role}:${r.capability}`);
    return m;
  }, [view.rows]);

  const deviating = React.useMemo(() => new Set(view.deviations), [view.deviations]);
  const modules = Array.from(new Set(view.capabilities.map((c) => c.module)));

  async function toggle(role: string, capability: string, next: boolean) {
    const key = `${role}:${capability}`;
    setBusy(key);
    try {
      await runAction(setPermission(orgId, role, capability, next));
      router.refresh();
    } catch (e) {
      toast.error("Could not change that permission", {
        description: describeError(e),
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      await runAction(resetToB7(orgId));
      toast.success("Reset to the approved matrix");
      router.refresh();
    } catch (e) {
      toast.error("Could not reset", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {!view.canEdit ? (
        <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/8 px-4 py-3 text-sm">
          <Eye className="mt-0.5 size-4 flex-shrink-0 text-info" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Read-only.</span>{" "}
            This is what your staff can reach, so you can see it — but permissions
            are governed centrally by OE Group and changed on the operator portal.
            Ask them for a change rather than looking for a switch here.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1.5">
            <label htmlFor="org" className="text-sm font-medium">Organisation</label>
            <Select
              id="org" className="w-72" value={orgId}
              onChange={(e) => { setOrgId(e.target.value); router.push(`?org=${e.target.value}`); }}
            >
              {view.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}{o.is_platform_operator ? " (operator)" : ""}
                </option>
              ))}
            </Select>
          </div>
          {view.deviations.length > 0 && (
            <Button variant="outline" size="sm" disabled={busy === "reset"} onClick={reset}>
              <RotateCcw className="size-4" />
              Reset to approved matrix
            </Button>
          )}
        </div>
      )}

      {view.deviations.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 text-sm">
          <ShieldCheck className="mt-0.5 size-4 flex-shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              {view.deviations.length} setting{view.deviations.length === 1 ? "" : "s"} differ
              from the board-approved B7 matrix.
            </span>{" "}
            Marked below. Deviation is allowed and sometimes right — it should
            just never be accidental.
          </p>
        </div>
      )}

      {modules.map((mod) => {
        const caps = view.capabilities.filter((c) => c.module === mod);
        return (
          <Card key={mod}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{mod}</CardTitle>
              {caps.every((c) => c.locked) && (
                <CardDescription>
                  These are not preferences. They are the controls an auditor
                  checks, and they are fixed in the database.
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="w-72 pb-2 text-left font-medium">Capability</th>
                    {ROLES.map((r) => (
                      <th key={r} className="pb-2 text-center text-xs font-medium text-muted-foreground">
                        {roleLabel(r, brand).split(" ")[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {caps.map((c) => (
                    <tr key={c.key} className="border-b border-border/60 last:border-0">
                      <td className="py-3 pr-4 align-top">
                        <div className="flex items-start gap-1.5">
                          {c.locked && <Lock className="mt-0.5 size-3.5 flex-shrink-0 text-muted-foreground" />}
                          <div>
                            <p className="font-medium">{c.label}</p>
                            <p className="text-xs text-muted-foreground">{c.description}</p>
                            {c.locked && (
                              <p className="mt-1 text-xs text-warning">{c.locked_reason}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      {ROLES.map((r) => {
                        const key = `${r}:${c.key}`;
                        const on = granted.has(key);
                        const drift = deviating.has(key);
                        if (c.locked) {
                          return (
                            <td key={r} className="py-3 text-center text-muted-foreground">
                              <Lock className="mx-auto size-3.5 opacity-40" />
                            </td>
                          );
                        }
                        return (
                          <td key={r} className="py-3 text-center">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={on}
                              aria-label={`${c.label} for ${roleLabel(r, brand)}`}
                              disabled={!view.canEdit || busy === key}
                              onClick={() => toggle(r, c.key, !on)}
                              className={cn(
                                "relative h-5 w-9 rounded-full transition-colors",
                                on ? "bg-[var(--brand)]" : "bg-muted",
                                drift && "ring-2 ring-warning ring-offset-1 ring-offset-background",
                                (!view.canEdit || busy === key) && "cursor-not-allowed opacity-60"
                              )}
                            >
                              <span
                                className={cn(
                                  "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                                  on ? "translate-x-4" : "translate-x-0.5"
                                )}
                              />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Changes take effect immediately and are enforced by the database, not by
        this screen — a revoked capability stops working even for someone calling
        the API directly. Every change is recorded in the audit trail with who
        made it and for which organisation.
      </p>
    </div>
  );
}
