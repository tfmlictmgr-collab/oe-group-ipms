"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload, FileSpreadsheet, Play, Wand2, CheckCircle2, TriangleAlert, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { validateStatementCsv, type StatementRow } from "@/lib/statement-import";
import { runAction, messageOf, hintOf } from "@/lib/run-action";
import type { ActionResult } from "@/lib/action-result";
import { commitStatementImport, autoMatch, runReconciliation, type ReconciliationResult } from "../actions";

export default function ReconcileClient({
  bankAccountId,
  bankLabel,
  currency,
  existingRefs,
}: {
  bankAccountId: string;
  bankLabel: string;
  currency: string;
  existingRefs: string[];
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [csvText, setCsvText] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<StatementRow[]>([]);
  const [headerIssues, setHeaderIssues] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [asOf, setAsOf] = React.useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = React.useState<ReconciliationResult | null>(null);

  const refSet = React.useMemo(() => new Set(existingRefs), [existingRefs]);

  function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) {
      toast.error("Unsupported file", { description: "Please upload a .csv statement export." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const res = validateStatementCsv(text, refSet);
      setCsvText(text);
      setFileName(file.name);
      setRows(res.rows);
      setHeaderIssues(res.headerIssues);
    };
    reader.onerror = () => toast.error("Could not read that file.");
    reader.readAsText(file);
  }

  const valid = rows.filter((r) => r.valid);
  const blocked = rows.length - valid.length;
  const warned = rows.filter((r) => r.possibleDuplicate).length;

  async function run<T>(fn: () => Promise<ActionResult<T>>, onOk: (r: T) => void) {
    setBusy(true);
    try {
      onOk(await runAction(fn()));
      router.refresh();
    } catch (e) {
      toast.error(messageOf(e), { description: hintOf(e), duration: Infinity, closeButton: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── 1. Import ─────────────────────────────────────────────────── */}
      {/* Screen-only: an empty upload box on paper is not evidence of a
          reconciliation, only of a form. What matters in print is the run
          history and the variance below. */}
      <Card data-print="screen-only">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Import a statement</CardTitle>
          <CardDescription>
            Export from your bank as CSV. A signed <code>amount</code> column, or
            separate <code>debit</code> and <code>credit</code> columns — both work.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/api/statement/template" download>
                <FileSpreadsheet /> Template
              </a>
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              <Upload /> {fileName ?? "Choose statement file"}
            </Button>
          </div>

          {headerIssues.length > 0 && (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
              <ul className="space-y-0.5">
                {headerIssues.map((h) => <li key={h}>{h}</li>)}
              </ul>
            </div>
          )}

          {rows.length > 0 && (
            <>
              <p className="text-sm">
                <span className="text-success">{valid.length} importable</span>
                {blocked > 0 && <> · <span className="text-destructive">{blocked} blocked</span></>}
                {warned > 0 && <> · <span className="text-warning">{warned} possible duplicate</span></>}
              </p>

              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Row</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.rowNumber} className={cn(!r.valid && "bg-destructive/5")}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{r.rowNumber}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.raw.date || "—"}</TableCell>
                        <TableCell className="max-w-[18rem] truncate">{r.raw.description || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.values ? formatMoney(r.values.amount, currency) : "—"}
                        </TableCell>
                        <TableCell>
                          {r.valid ? (
                            r.possibleDuplicate ? (
                              <Badge variant="warning">Possible duplicate</Badge>
                            ) : (
                              <Badge variant="success">OK</Badge>
                            )
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
                    ))}
                  </TableBody>
                </Table>
              </div>

              {warned > 0 && (
                <p className="text-xs text-muted-foreground">
                  Possible duplicates are imported. Two identical charges on one
                  day are normal, so we flag rather than drop them — review and
                  ignore any that really are repeats.
                </p>
              )}

              <Button
                variant="brand"
                disabled={busy || valid.length === 0}
                onClick={() =>
                  run(
                    () => commitStatementImport(bankAccountId, csvText!),
                    (r) => {
                      toast.success(`Imported ${r.imported} line(s)`, {
                        description: r.skipped ? `${r.skipped} skipped.` : undefined,
                      });
                      setRows([]); setCsvText(null); setFileName(null);
                      if (inputRef.current) inputRef.current.value = "";
                    }
                  )
                }
              >
                Import {valid.length} line{valid.length === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Match + run ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">2. Match and reconcile</CardTitle>
          <CardDescription>
            Matching is conservative — a line is only matched when exactly one
            ledger entry fits. Anything ambiguous is left for you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div data-print="screen-only" className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="asof">As at</Label>
              <Input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(() => autoMatch(bankAccountId), (n) =>
                  toast.success(n > 0 ? `Matched ${n} line(s)` : "No new matches", {
                    description: n === 0 ? "Anything left needs a human decision." : undefined,
                  })
                )
              }
            >
              <Wand2 /> Auto-match
            </Button>
            <Button
              variant="brand"
              disabled={busy}
              onClick={() =>
                run(() => runReconciliation(bankAccountId, asOf), (r) => {
                  setResult(r);
                  if (r.status === "balanced") {
                    toast.success("Reconciled — no variance");
                  } else {
                    toast.error("Variance found", {
                      description: `${formatMoney(r.variance, currency)} unexplained.`,
                    });
                  }
                })
              }
            >
              <Play /> Run reconciliation
            </Button>
          </div>

          {result && (
            <div
              className={cn(
                "space-y-3 rounded-md border p-4",
                result.status === "balanced"
                  ? "border-success/40 bg-success/5"
                  : "border-destructive/40 bg-destructive/5"
              )}
            >
              <p className="flex items-center gap-2 font-medium">
                {result.status === "balanced" ? (
                  <><CheckCircle2 className="size-4 text-success" /> Balanced — {bankLabel} agrees with the ledger</>
                ) : (
                  <><TriangleAlert className="size-4 text-destructive" /> Variance of {formatMoney(result.variance, currency)}</>
                )}
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Ledger says</dt>
                  <dd className="tabular-nums">{formatMoney(result.ledger_balance, currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Bank says</dt>
                  <dd className="tabular-nums">{formatMoney(result.statement_balance, currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Matched</dt>
                  <dd className="tabular-nums">{result.matched_lines}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Unmatched</dt>
                  <dd className="tabular-nums">{result.unmatched_lines}</dd>
                </div>
              </dl>
              {result.status !== "balanced" && (
                <p className="text-xs text-muted-foreground">
                  A variance means either a bank movement not in the books, or a
                  posting that never reached the bank. Both need explaining before
                  any further disbursement.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
