"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, RotateCcw, ShieldCheck, Eye, ChevronDown, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
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
  "regional_manager",
  // 0307 — added in the same change that created it, for once.
  "operations_executive",
  "finance_approver",
  // 0151 created these two and this list was never told — the third time this
  // exact omission has happened here, after `executive` and `regional_manager`.
  // They carry real seeded grants (the auditor holds org-wide sight of the
  // request queue, which is not a small one), and an administrator could see
  // none of it.
  "payment_audit_approver", "payment_approver",
  "property_owner",
  // 0327. Its column holds its own five switches and nothing else.
  "owner_representative",
  "viewer",
  "executive", "admin",
] as const;

// ⚠️ NOT `roleLabel(...).split(" ")[0]`, which is what these headers used to be.
// Three roles begin with "Payment" and two with "Propert", so the columns read
// as duplicates of each other: "Properties" (the properties manager) sat four
// columns from "Property" (the property owner), and adding the two payment
// roles above would have produced three columns all headed "Payment". A column
// heading that cannot be told from its neighbour is worse on a permission grid
// than a long one.
const SHORT_LABEL: Record<string, string> = {
  tenant: "Tenant",
  vendor: "Vendor",
  fm_ops_staff: "Ops staff",
  facility_manager: "FM",
  property_manager: "PM",
  regional_manager: "Regional",
  operations_executive: "Executive",
  finance_approver: "Pay officer",
  payment_audit_approver: "Pay auditor",
  payment_approver: "Pay approver",
  property_owner: "Owner",
  owner_representative: "Owner Rep",
  viewer: "Read-only",
  executive: "MD / MP",
  admin: "Admin",
};

/**
 * Capabilities that mean something for one role only (0310). Every other
 * role's cell shows a dash rather than a switch that would change nothing —
 * a toggle that does nothing teaches people the matrix is decorative.
 */
const ONLY_FOR: Record<string, readonly string[]> = {
  "requisitions.approve_within_limit": ["operations_executive"],
  "operations.org_wide": ["operations_executive"],
  // 0327. The Owner Rep's own switches.
  "owner_rep.properties": ["owner_representative"],
  "owner_rep.requests_read": ["owner_representative"],
  "owner_rep.requests_raise": ["owner_representative"],
  "owner_rep.assets": ["owner_representative"],
  "owner_rep.analytics": ["owner_representative"],
};

/**
 * A role that may hold nothing but its own switches (0327). Every other cell in
 * its column is a dash: `set_role_permission` refuses those grants and
 * `has_permission` ignores them, so offering a switch would be offering a lie —
 * the Owner Rep sees no money by any route, and these are the routes.
 */
const OWN_SWITCHES_ONLY: Record<string, string> = {
  owner_representative: "owner_rep.",
};

function hasNoEffect(capability: string, role: string): boolean {
  if (ONLY_FOR[capability] && !ONLY_FOR[capability].includes(role)) return true;
  const own = OWN_SWITCHES_ONLY[role];
  return own !== undefined && !capability.startsWith(own);
}

/** Which groups are open, remembered per browser. Collapsed by default: the
 *  matrix is long, and a group with a deviation in it opens itself. */
const OPEN_KEY = "permissions-matrix:open-groups";
function readOpen(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}
function writeOpen(open: Set<string>) {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Private window or blocked storage: the groups still work, just unremembered.
  }
}

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

  // Deviations per group, so a collapsed group still says it holds one.
  const driftByModule = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of view.capabilities) {
      const n = view.deviations.filter((d) => d.endsWith(`:${c.key}`)).length;
      if (n) m.set(c.module, (m.get(c.module) ?? 0) + n);
    }
    return m;
  }, [view.capabilities, view.deviations]);

  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(modules.filter((m) => driftByModule.has(m)))
  );
  // Restore the remembered set after mount (localStorage is browser-only).
  React.useEffect(() => {
    const saved = readOpen();
    if (saved) setOpen(saved);
  }, []);
  const setAndSave = (next: Set<string>) => {
    setOpen(next);
    writeOpen(next);
  };
  const toggleGroup = (mod: string) => {
    const next = new Set(open);
    if (next.has(mod)) next.delete(mod);
    else next.add(mod);
    setAndSave(next);
  };

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
            are governed centrally by TENTai and changed on the operator portal.
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

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setAndSave(new Set(modules))}>
          <ChevronsUpDown className="size-4" /> Expand all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAndSave(new Set())}>
          <ChevronsDownUp className="size-4" /> Collapse all
        </Button>
      </div>

      {modules.map((mod) => {
        const caps = view.capabilities.filter((c) => c.module === mod);
        const isOpen = open.has(mod);
        const drift = driftByModule.get(mod) ?? 0;
        const panelId = `perm-group-${mod.replace(/\W+/g, "-").toLowerCase()}`;
        return (
          <Card key={mod}>
            <CardHeader className={isOpen ? "pb-3" : undefined}>
              <button
                type="button"
                onClick={() => toggleGroup(mod)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="space-y-0.5">
                  <CardTitle className="text-base">{mod}</CardTitle>
                  <span className="block text-xs text-muted-foreground">
                    {caps.length} capabilit{caps.length === 1 ? "y" : "ies"}
                    {drift > 0 && (
                      <span className="text-warning">
                        {" "}· {drift} differ{drift === 1 ? "s" : ""} from the approved matrix
                      </span>
                    )}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 flex-shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-180"
                  )}
                />
              </button>
              {isOpen && caps.every((c) => c.locked) && (
                <CardDescription>
                  These are not preferences. They are the controls an auditor
                  checks, and they are fixed in the database.
                </CardDescription>
              )}
            </CardHeader>
            {isOpen && (
            <CardContent id={panelId} className="overflow-x-auto">
              <table className="w-full min-w-[62rem] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="w-72 pb-2 text-left font-medium">Capability</th>
                    {ROLES.map((r) => (
                      <th
                        key={r}
                        title={roleLabel(r, brand)}
                        className="pb-2 text-center text-xs font-medium text-muted-foreground"
                      >
                        {SHORT_LABEL[r] ?? roleLabel(r, brand)}
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
                        if (hasNoEffect(c.key, r)) {
                          return (
                            <td
                              key={r}
                              className="py-3 text-center text-muted-foreground"
                              title={`Has no effect for ${roleLabel(r, brand)}`}
                            >
                              —
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
            )}
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
