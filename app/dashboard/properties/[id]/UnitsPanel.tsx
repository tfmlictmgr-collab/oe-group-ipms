"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus, Upload, FileSpreadsheet, Trash2, AlertCircle, PieChart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { runAction, describeError } from "@/lib/run-action";
import {
  validateUnitCsv, buildUnitTemplateCsv, previewShares, type ValidatedUnit,
} from "@/lib/unit-import";
import { effectiveFactor } from "@/lib/apportionment";
import {
  saveUnit, retireUnit, commitUnitImport, unitImportContext, assignUnitOccupant,
  addUnitType,
} from "../actions";

export type UnitRow = {
  id: string;
  label: string;
  apportionment_factor: number | string;
  unit_quantity: number | string | null;
  description: string | null;
  occupant_user_id: string | null;
  /**
   * The database's own answer (0200), not `occupant_user_id === null`. A unit
   * under a live tenancy that never recorded an occupant is not free, and this
   * panel is where someone decides whether to let it.
   */
  is_vacant: boolean;
};

/** The offered descriptions, grouped as the board asked (0198). */
export type UnitType = { id: string; label: string; category: "residential" | "commercial" };

export type Member = { id: string; full_name: string | null; email: string | null };

export default function UnitsPanel({
  propertyId, units, members, unitTypes, canWrite,
}: {
  propertyId: string;
  units: UnitRow[];
  members: Member[];
  unitTypes: UnitType[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({
    label: "", factor: "", quantity: "1", description: "", occupant: "",
  });
  // "" is the ordinary state; ADD_NEW opens the free-text box. Kept separate
  // from `form.label` so choosing "Something else…" does not momentarily file a
  // unit literally called that.
  const [newType, setNewType] = React.useState<string | null>(null);

  // Import
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [csv, setCsv] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<ValidatedUnit[]>([]);
  const [headerIssues, setHeaderIssues] = React.useState<string[]>([]);

  // ⚠️ Weighted through `effectiveFactor` — the function the actual
  // apportionment uses — so this panel and the invoice cannot disagree about
  // what a row weighs. A row of 12 stalls at 20 m² counts 240, not 20.
  const weightOf = (u: UnitRow) =>
    effectiveFactor({ factor: Number(u.apportionment_factor), quantity: Number(u.unit_quantity ?? 1) });
  const totalFactor = units.reduce((s, u) => s + weightOf(u), 0);
  const totalUnits = units.reduce((s, u) => s + Number(u.unit_quantity ?? 1), 0);
  const vacantUnits = units.filter((u) => u.is_vacant).length;
  const nameOf = (id: string | null) =>
    id ? members.find((m) => m.id === id)?.full_name ?? "Assigned" : null;

  // Adds a description to THIS org's list and selects it, so the person filing
  // the first boat shed in the register is not sent to a settings screen to do
  // it. The category is asked rather than guessed — a "Lounge" is residential
  // in one portfolio and commercial in another, and guessing wrong puts it in
  // the wrong half of every future dropdown.
  async function addType(category: "residential" | "commercial") {
    const label = (newType ?? "").trim();
    if (!label) return;
    setBusy("type");
    try {
      await runAction(addUnitType(label, category));
      setForm((f) => ({ ...f, label }));
      setNewType(null);
      toast.success(`"${label}" added to your list`);
      router.refresh();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function addUnit() {
    setBusy("add");
    try {
      const r = await runAction(saveUnit({
        propertyId, label: form.label,
        apportionmentFactor: form.factor,
        unitQuantity: form.quantity,
        description: form.description,
        occupantUserId: form.occupant || null,
      }));
      toast.success(
        r.created === 1 ? "Unit added" : `${r.created} units added, numbered`
      );
      setForm({ label: "", factor: "", quantity: "1", description: "", occupant: "" });
      setNewType(null);
      setAdding(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not add that unit", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(null); }
  }

  async function assign(unitId: string, occupant: string) {
    setBusy(unitId);
    try {
      await runAction(assignUnitOccupant(unitId, occupant || null));
      router.refresh();
    } catch (e) {
      toast.error("Could not change the occupant", { description: describeError(e) });
    } finally { setBusy(null); }
  }

  async function retire(unitId: string) {
    setBusy(unitId);
    try {
      await runAction(retireUnit(unitId, propertyId));
      toast.success("Unit retired");
      router.refresh();
    } catch (e) {
      // The refusal names what is in the way — an occupant, an unpaid charge.
      toast.error("Could not retire that unit", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(null); }
  }

  async function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) {
      toast.error("Unsupported file", { description: "Please upload a .csv." });
      return;
    }
    const text = await file.text();
    try {
      const ctx = await runAction(unitImportContext(propertyId));
      const res = validateUnitCsv(text, {
        existingLabels: new Set(ctx.existingLabels),
        memberEmails: new Set(ctx.members.map((m) => m.email)),
      });
      setCsv(text);
      setRows(res.rows);
      setHeaderIssues(res.headerIssues);
    } catch (e) {
      toast.error("Could not read that file", { description: describeError(e) });
    }
  }

  async function commitImport() {
    setBusy("import");
    try {
      const r = await runAction(commitUnitImport(propertyId, csv!));
      toast.success(`Imported ${r.inserted} unit${r.inserted === 1 ? "" : "s"}`);
      discardImport();
      router.refresh();
    } catch (e) {
      toast.error("Nothing was imported", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(null); }
  }

  function discardImport() {
    setRows([]);
    setCsv(null);
    setHeaderIssues([]);
    // Without this, choosing the SAME filename again fires no change event —
    // which is exactly what someone does after correcting the file in place.
    if (fileRef.current) fileRef.current.value = "";
  }

  const validRows = rows.filter((r) => r.valid);
  const shares = previewShares(rows);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Units</CardTitle>
              <CardDescription>
                Occupied space — floor area in square metres, per unit —
                decides each unit&apos;s share of a service-charge budget.
                Adding several of a type creates one row each, so every unit can
                be let, billed and counted vacant on its own.
                {totalFactor > 0 && ` ${totalUnits.toLocaleString()} unit${totalUnits === 1 ? "" : "s"}, ${vacantUnits.toLocaleString()} vacant, ${totalFactor.toLocaleString()} m² across this property.`}
              </CardDescription>
            </div>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}>
                  <Plus className="size-4" /> Add unit
                </Button>
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  <Upload className="size-4" /> Bulk import
                </Button>
                <input
                  ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {adding && (
            <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="space-y-1.5">
                <Label htmlFor="u-occ">Occupant</Label>
                <Select id="u-occ" value={form.occupant}
                        onChange={(e) => setForm((f) => ({ ...f, occupant: e.target.value }))}>
                  <option value="">— vacant —</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name ?? m.email}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-label">Label</Label>
                {newType === null ? (
                  <Select
                    id="u-label"
                    value={form.label}
                    onChange={(e) => {
                      if (e.target.value === "__add__") { setNewType(""); setForm((f) => ({ ...f, label: "" })); }
                      else setForm((f) => ({ ...f, label: e.target.value }));
                    }}
                  >
                    <option value="">— choose —</option>
                    <optgroup label="Residential">
                      {unitTypes.filter((t) => t.category === "residential").map((t) => (
                        <option key={t.id} value={t.label}>{t.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Commercial">
                      {unitTypes.filter((t) => t.category === "commercial").map((t) => (
                        <option key={t.id} value={t.label}>{t.label}</option>
                      ))}
                    </optgroup>
                    <option value="__add__">Something else…</option>
                  </Select>
                ) : (
                  <div className="space-y-1">
                    <Input
                      autoFocus value={newType} placeholder="e.g. Boat Shed"
                      onChange={(e) => setNewType(e.target.value)}
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm" variant="outline" className="h-7 px-2 text-xs"
                        disabled={!newType.trim() || busy === "type"}
                        onClick={() => void addType("residential")}
                      >
                        Residential
                      </Button>
                      <Button
                        size="sm" variant="outline" className="h-7 px-2 text-xs"
                        disabled={!newType.trim() || busy === "type"}
                        onClick={() => void addType("commercial")}
                      >
                        Commercial
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => setNewType(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-qty">How many</Label>
                <Input id="u-qty" inputMode="numeric" value={form.quantity} placeholder="1"
                       onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
                <p className="text-[11px] text-muted-foreground">
                  {Number(form.quantity) > 1
                    ? `Creates ${Number(form.quantity)} rows, numbered — each can be let and go vacant on its own.`
                    : "One row each, so each can be let separately."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-factor">Occupied Space</Label>
                <div className="relative">
                  <Input id="u-factor" inputMode="decimal" value={form.factor} placeholder="85.5"
                         className="pr-9"
                         onChange={(e) => setForm((f) => ({ ...f, factor: e.target.value }))} />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    m²
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">Per unit, not the total.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-desc">Description</Label>
                <Input id="u-desc" value={form.description} placeholder="Block A, ground floor"
                       onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="flex items-end">
                <Button size="sm" variant="brand" disabled={busy === "add"} onClick={addUnit}>
                  {busy === "add" ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          )}

          {units.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No units yet. A property with no units cannot be invoiced — a
              budget has nothing to apportion across.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Occupant</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Occupied Space</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    {canWrite && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {units.map((u) => {
                    const f = Number(u.apportionment_factor);
                    const weight = weightOf(u);
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          {canWrite ? (
                            <Select
                              value={u.occupant_user_id ?? ""}
                              disabled={busy === u.id}
                              onChange={(e) => assign(u.id, e.target.value)}
                              className="h-8 text-xs"
                            >
                              <option value="">— vacant —</option>
                              {members.map((m) => (
                                <option key={m.id} value={m.id}>{m.full_name ?? m.email}</option>
                              ))}
                            </Select>
                          ) : u.occupant_user_id ? (
                            <Badge variant="success">{nameOf(u.occupant_user_id)}</Badge>
                          ) : (
                            <Badge variant="muted">{u.is_vacant ? "Vacant" : "Let"}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{u.label}</TableCell>
                        {/* The database's rule, not this column's own reading of
                            the occupant dropdown. "Let" is a unit under a live
                            tenancy that recorded no occupant — free to the eye,
                            not free to let. */}
                        <TableCell>
                          <Badge variant={u.is_vacant ? "muted" : "success"}>
                            {u.is_vacant ? "Vacant" : "Occupied"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {f.toLocaleString()} m²
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-muted-foreground" title={u.description ?? ""}>
                          {u.description || "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {totalFactor > 0 ? `${((weight / totalFactor) * 100).toFixed(1)}%` : "—"}
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <Button
                              size="icon-sm" variant="ghost" title="Retire this unit"
                              disabled={busy === u.id} onClick={() => retire(u.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Import preview ────────────────────────────────────────────────── */}
      {(rows.length > 0 || headerIssues.length > 0) && (
        <Card className={cn(validRows.length !== rows.length && "border-destructive/40")}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Import preview</CardTitle>
            <CardDescription>
              Nothing is written until every row is valid. A partly imported block
              would change what every other unit pays, without saying so.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {headerIssues.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm">
                <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
                <ul>{headerIssues.map((h) => <li key={h}>{h}</li>)}</ul>
              </div>
            )}

            {rows.length > 0 && (
              <>
                <p className="text-sm">
                  <span className="text-success">{validRows.length} ready</span>
                  {validRows.length !== rows.length && (
                    <> · <span className="text-destructive">{rows.length - validRows.length} blocked</span></>
                  )}
                </p>

                <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-14">Row</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Weighted space</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => {
                        const share = shares.find((s) => s.label === r.values?.label);
                        return (
                          <TableRow key={r.rowNumber} className={cn(!r.valid && "bg-destructive/5")}>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {r.rowNumber}
                            </TableCell>
                            <TableCell>{r.raw.label || "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {r.raw.apportionment_factor || "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {share ? `${share.pct.toFixed(1)}%` : "—"}
                            </TableCell>
                            <TableCell>
                              {r.valid ? (
                                <Badge variant="success">OK</Badge>
                              ) : (
                                <div className="space-y-1">
                                  <Badge variant="destructive">Blocked</Badge>
                                  <ul className="space-y-0.5 text-xs text-destructive">
                                    {r.issues.map((i, n) => <li key={n}>{i.message}</li>)}
                                  </ul>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {shares.length > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <PieChart className="mt-0.5 size-3 flex-shrink-0" />
                    Shares shown are across the imported rows only. Check the
                    largest looks right — an apportionment mistake is invisible as
                    a number and obvious as a percentage.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="brand" size="sm"
                    disabled={busy === "import" || validRows.length !== rows.length}
                    onClick={commitImport}
                  >
                    {busy === "import" ? "Importing…" : `Import ${validRows.length} unit(s)`}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={discardImport}>
                    Discard
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {canWrite && (
        <Button asChild variant="ghost" size="sm">
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(buildUnitTemplateCsv())}`}
            download="units-template.csv"
          >
            <FileSpreadsheet className="size-4" /> Download the unit template
          </a>
        </Button>
      )}
    </div>
  );
}
