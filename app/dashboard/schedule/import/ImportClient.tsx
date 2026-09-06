"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, Download, Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { TENANCY_COLUMNS } from "@/lib/tenancy-import";
import { runAction, describeError } from "@/lib/run-action";
import {
  previewTenancyImport, commitTenancyImport, type PreviewRow,
} from "./actions";

/**
 * Upload a sheet, see exactly what it will do, then commit it.
 *
 * ⚠️ The preview is computed on the SERVER, not here. The asset importer
 * validates in the browser for speed and re-validates at commit; this one does
 * not, because the checks that matter most — is that unit already let, does
 * this email match a real account — need data the browser has no business
 * holding. Sending the file up and getting back a verdict is one round trip and
 * removes any chance of the screen promising something the write would refuse.
 */
export default function ImportClient() {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [csvText, setCsvText] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<PreviewRow[]>([]);
  const [headerIssues, setHeaderIssues] = React.useState<string[]>([]);
  const [summary, setSummary] = React.useState<{
    validCount: number; willActivate: number; linkedToAccounts: number;
  } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  function reset() {
    setFileName(null); setCsvText(null); setRows([]);
    setHeaderIssues([]); setSummary(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) {
      toast.error("Unsupported file", {
        description: "Upload a .csv. In Excel: File → Save As → CSV UTF-8.",
      });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("That file is too large", {
        description: "2 MB is thousands of tenancies — check you have not attached a workbook.",
      });
      return;
    }

    const text = await file.text();
    setFileName(file.name);
    setCsvText(text);
    setChecking(true);
    try {
      const r = await runAction(previewTenancyImport(text));
      setRows(r.rows);
      setHeaderIssues(r.headerIssues);
      setSummary({
        validCount: r.validCount,
        willActivate: r.willActivate,
        linkedToAccounts: r.linkedToAccounts,
      });
    } catch (err) {
      toast.error("Could not read that file", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
      reset();
    } finally {
      setChecking(false);
    }
  }

  async function commit() {
    if (!csvText) return;
    setCommitting(true);
    try {
      const r = await runAction(commitTenancyImport(csvText));
      toast.success(
        `${r.inserted} ${r.inserted === 1 ? "tenancy" : "tenancies"} recorded`,
        {
          description:
            r.activated > 0
              ? `${r.activated} activated, so their units now read as occupied.`
              : "All recorded as drafts — activate them to occupy their units.",
          duration: Infinity,
          closeButton: true,
        }
      );
      router.push("/dashboard/schedule");
      router.refresh();
    } catch (err) {
      toast.error("Nothing was imported", {
        description: describeError(err), duration: Infinity, closeButton: true,
      });
    } finally {
      setCommitting(false);
    }
  }

  const bad = rows.filter((r) => !r.valid);
  const ready = rows.length > 0 && bad.length === 0 && !checking;

  return (
    <div className="space-y-6">
      {/* ── Pick a file ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">The sheet</CardTitle>
          <CardDescription>
            One row per tenancy, with the columns below. Start from the template
            if you are not sure — it carries the headings and an example row.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors",
              dragging ? "border-brand bg-brand/5" : "border-border"
            )}
          >
            <FileSpreadsheet className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">
                {fileName ?? "Drop a CSV here, or choose one"}
              </p>
              <p className="text-xs text-muted-foreground">
                Up to 500 tenancies at a time — one sheet of the portfolio.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button" size="sm" variant="outline" disabled={checking}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="size-4" /> {fileName ? "Choose another" : "Choose a file"}
              </Button>
              <Button asChild size="sm" variant="ghost">
                <a href="/api/schedule/template" download>
                  <Download className="size-4" /> Download the template
                </a>
              </Button>
              {fileName && (
                <Button type="button" size="sm" variant="ghost" onClick={reset}>
                  Clear
                </Button>
              )}
            </div>
            <input
              ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
          </div>

          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium">
              The columns ({TENANCY_COLUMNS.length})
            </summary>
            <dl className="mt-2 space-y-1.5">
              {TENANCY_COLUMNS.map((c) => (
                <div key={c.key} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                  <dt className="font-mono font-medium">{c.key}</dt>
                  {c.required && <Badge variant="outline">required</Badge>}
                  <dd className="text-muted-foreground">{c.hint}</dd>
                </div>
              ))}
            </dl>
            {/* ⚠️ Said here rather than discovered. Somebody looking at the
                workbook will expect to bring the money columns across. */}
            <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
              Rent billed, rent collected, management fee and service charge are
              deliberately <span className="font-medium">not</span> imported.
              They are worked out from the ledger, so a column here would be a
              second set of figures that could disagree with it.
            </p>
          </details>
        </CardContent>
      </Card>

      {checking && (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">
          Checking every row against your properties…
        </CardContent></Card>
      )}

      {/* ── What it will do ─────────────────────────────────────────────── */}
      {summary && !checking && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What this will do</CardTitle>
            <CardDescription>
              Nothing is recorded until you press the button below, and it is all
              or nothing — a half-imported rent roll cannot be told from a whole
              one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {headerIssues.length > 0 && (
              <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                {headerIssues.map((h) => (
                  <p key={h} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
                    {h}
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-4 text-sm">
              <Stat label="Rows read" value={rows.length} />
              <Stat label="Ready" value={summary.validCount} tone={bad.length ? undefined : "good"} />
              <Stat label="With a problem" value={bad.length} tone={bad.length ? "bad" : undefined} />
              <Stat label="Will occupy their unit" value={summary.willActivate} />
              <Stat label="Linked to a portal account" value={summary.linkedToAccounts} />
            </div>

            {summary.linkedToAccounts < summary.validCount && summary.validCount > 0 && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Link2 className="mt-0.5 size-3.5 flex-shrink-0" />
                The rest are recorded against the tenant&rsquo;s name and phone,
                with no portal account. That is normal — a company let has none
                either — and the schedule shows them by name. An email is only
                ever matched to an account that already exists; importing never
                creates one.
              </p>
            )}

            {ready ? (
              <Button variant="brand" disabled={committing} onClick={commit}>
                <CheckCircle2 className="size-4" />
                {committing
                  ? "Recording…"
                  : `Record ${summary.validCount} ${summary.validCount === 1 ? "tenancy" : "tenancies"}`}
              </Button>
            ) : (
              <p className="text-sm text-warning">
                {bad.length} row{bad.length === 1 ? "" : "s"} still need fixing.
                Correct them in your sheet and upload it again — nothing is
                imported while any row has a problem.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Every row, and what is wrong with it ────────────────────────── */}
      {rows.length > 0 && !checking && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Row by row</CardTitle>
            <CardDescription>
              Row numbers are the lines in your own file, so &ldquo;row 7&rdquo;
              is row 7 in the spreadsheet.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Row</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead className="text-right">Rent</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <React.Fragment key={r.rowNumber}>
                    <TableRow className={cn(!r.valid && "bg-destructive/5")}>
                      <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
                      <TableCell>{r.display.property}</TableCell>
                      <TableCell>{r.display.unit}</TableCell>
                      <TableCell>{r.display.tenant}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.display.term}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.display.rent}</TableCell>
                      <TableCell>
                        {r.valid ? (
                          <Badge variant={r.display.status === "active" ? "success" : "outline"}>
                            {r.display.status}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">problem</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                    {r.issues.map((i, n) => (
                      <TableRow key={`${r.rowNumber}-${n}`} className="bg-destructive/5">
                        <TableCell />
                        <TableCell colSpan={6} className="py-1 text-xs text-destructive">
                          <span className="font-mono">{i.column}</span> — {i.message}
                        </TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label, value, tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive"
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
