"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { validateAssetCsv, type ValidatedRow } from "@/lib/asset-import";
import { commitAssetImport } from "../actions";
import { runAction, describeError } from "@/lib/run-action";

type RawCtx = {
  properties: [string, string][];
  units: [string, string][];
  vendors: [string, string][];
  users: [string, string][];
  existingTags: string[];
  customFieldKeys: string[];
};

export default function ImportClient({
  rawCtx,
  propertyNames,
}: {
  rawCtx: RawCtx;
  propertyNames: string[];
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [csvText, setCsvText] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<ValidatedRow[]>([]);
  const [headerIssues, setHeaderIssues] = React.useState<string[]>([]);
  const [committing, setCommitting] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  const ctx = React.useMemo(
    () => ({
      propertiesByName: new Map(rawCtx.properties),
      unitsByKey: new Map(rawCtx.units),
      vendorsByName: new Map(rawCtx.vendors),
      usersByEmail: new Map(rawCtx.users),
      existingTags: new Set(rawCtx.existingTags),
      customFieldKeys: rawCtx.customFieldKeys,
    }),
    [rawCtx]
  );

  function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) {
      toast.error("Unsupported file", { description: "Please upload a .csv file." });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File too large", { description: "Keep imports under 5 MB (about 20,000 rows)." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const result = validateAssetCsv(text, ctx);
      setCsvText(text);
      setFileName(file.name);
      setRows(result.rows);
      setHeaderIssues(result.headerIssues);
      if (result.rows.length === 0) {
        toast.error("Nothing to import", { description: "No data rows were found in that file." });
      }
    };
    reader.onerror = () => toast.error("Could not read that file.");
    reader.readAsText(file);
  }

  const validCount = rows.filter((r) => r.valid).length;
  const invalidCount = rows.length - validCount;

  async function commit() {
    if (!csvText || validCount === 0) return;
    setCommitting(true);
    try {
      // The server re-validates from scratch — the preview is a courtesy, not
      // the authority.
      const res = await runAction(commitAssetImport(csvText));
      if (res.inserted > 0) {
        toast.success(`Imported ${res.inserted} asset${res.inserted === 1 ? "" : "s"}`, {
          description: res.failed.length
            ? `${res.failed.length} row(s) were skipped.`
            : "All rows imported cleanly.",
        });
        router.push("/dashboard/assets");
        router.refresh();
      } else {
        toast.error("Nothing was imported", {
          description: res.failed[0]?.reason ?? "Every row was rejected.",
        });
      }
    } catch (e) {
      toast.error("Import failed", {
        description: describeError(e),
      });
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setCsvText(null); setFileName(null); setRows([]); setHeaderIssues([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="space-y-6">
      {/* Step 1 — get the template */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Start from the template</CardTitle>
          <CardDescription>
            It carries every column, a guidance row explaining each one, and a worked
            example. Leave optional columns blank — only property, asset tag and name
            are required.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild variant="outline" size="sm">
            <a href="/api/assets/template" download>
              <Download /> Download template (.csv)
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            Property names must match exactly:{" "}
            {propertyNames.length ? (
              <span className="font-medium text-foreground">{propertyNames.join(" · ")}</span>
            ) : (
              <span className="text-warning">you don&apos;t manage any properties yet</span>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Step 2 — upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Upload your completed file</CardTitle>
          <CardDescription>Nothing is saved until you confirm on the next step.</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-[var(--brand)] bg-[var(--brand)]/5" : "border-border bg-card/50"
            )}
          >
            <FileSpreadsheet className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {fileName ?? "Drop your CSV here, or choose a file"}
              </p>
              <p className="text-xs text-muted-foreground">CSV only · up to 5 MB</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              id="asset-csv"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                <Upload /> Choose file
              </Button>
              {fileName && (
                <Button type="button" variant="ghost" size="sm" onClick={reset}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Step 3 — preview */}
      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base">3. Check the preview</CardTitle>
                <CardDescription>
                  <span className="text-success">{validCount} valid</span>
                  {invalidCount > 0 && (
                    <> · <span className="text-destructive">{invalidCount} blocked</span></>
                  )}{" "}
                  — invalid rows are never partially imported.
                </CardDescription>
              </div>
              <Button
                variant="brand"
                onClick={commit}
                disabled={committing || validCount === 0}
              >
                {committing ? "Importing…" : `Import ${validCount} valid row${validCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-0 pb-0">
            {headerIssues.length > 0 && (
              <div className="mx-5 flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
                <ul className="space-y-0.5">
                  {headerIssues.map((h) => <li key={h}>{h}</li>)}
                </ul>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Row</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.rowNumber} className={r.valid ? "" : "bg-destructive/5"}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.rowNumber}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.raw.asset_tag || "—"}</TableCell>
                    <TableCell className="max-w-[16rem] truncate">{r.raw.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.category || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.property_name || "—"}</TableCell>
                    <TableCell>
                      {r.valid ? (
                        <Badge variant="success">
                          <CheckCircle2 className="size-3" /> Valid
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="destructive">Blocked</Badge>
                          <ul className="space-y-0.5 text-xs text-destructive">
                            {r.issues.map((i, n) => (
                              <li key={n}>{i.column}: {i.message}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
