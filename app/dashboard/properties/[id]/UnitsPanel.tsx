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
import { saveUnit, retireUnit, commitUnitImport, unitImportContext } from "../actions";

export type UnitRow = {
  id: string;
  label: string;
  apportionment_factor: number | string;
  occupant_user_id: string | null;
};

export type Member = { id: string; full_name: string | null; email: string | null };

export default function UnitsPanel({
  propertyId, units, members, canWrite,
}: {
  propertyId: string;
  units: UnitRow[];
  members: Member[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({ label: "", factor: "", occupant: "" });

  // Import
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [csv, setCsv] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<ValidatedUnit[]>([]);
  const [headerIssues, setHeaderIssues] = React.useState<string[]>([]);

  const totalFactor = units.reduce((s, u) => s + Number(u.apportionment_factor), 0);
  const nameOf = (id: string | null) =>
    id ? members.find((m) => m.id === id)?.full_name ?? "Assigned" : null;

  async function addUnit() {
    setBusy("add");
    try {
      await runAction(saveUnit({
        propertyId, label: form.label,
        apportionmentFactor: form.factor,
        occupantUserId: form.occupant || null,
      }));
      toast.success("Unit added");
      setForm({ label: "", factor: "", occupant: "" });
      setAdding(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not add that unit", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(null); }
  }

  async function assign(unitId: string, label: string, factor: number, occupant: string) {
    setBusy(unitId);
    try {
      await runAction(saveUnit({
        id: unitId, propertyId, label,
        apportionmentFactor: String(factor),
        occupantUserId: occupant || null,
      }));
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
      setCsv(null); setRows([]); setHeaderIssues([]);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (e) {
      toast.error("Nothing was imported", {
        description: describeError(e), duration: Infinity, closeButton: true,
      });
    } finally { setBusy(null); }
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
                The apportionment factor decides each unit&apos;s share of a
                service-charge budget — usually floor area.
                {totalFactor > 0 && ` Total across this property: ${totalFactor.toLocaleString()}.`}
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
            <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="u-label">Label</Label>
                <Input id="u-label" value={form.label} placeholder="Flat 2"
                       onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="u-factor">Factor</Label>
                <Input id="u-factor" inputMode="decimal" value={form.factor} placeholder="85.5"
                       onChange={(e) => setForm((f) => ({ ...f, factor: e.target.value }))} />
              </div>
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
                    <TableHead>Unit</TableHead>
                    <TableHead className="text-right">Factor</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead>Occupant</TableHead>
                    {canWrite && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {units.map((u) => {
                    const f = Number(u.apportionment_factor);
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{f.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {totalFactor > 0 ? `${((f / totalFactor) * 100).toFixed(1)}%` : "—"}
                        </TableCell>
                        <TableCell>
                          {canWrite ? (
                            <Select
                              value={u.occupant_user_id ?? ""}
                              disabled={busy === u.id}
                              onChange={(e) => assign(u.id, u.label, f, e.target.value)}
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
                            <Badge variant="muted">Vacant</Badge>
                          )}
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
                        <TableHead>Unit</TableHead>
                        <TableHead className="text-right">Factor</TableHead>
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
                  <Button variant="ghost" size="sm" onClick={() => { setRows([]); setCsv(null); setHeaderIssues([]); }}>
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
