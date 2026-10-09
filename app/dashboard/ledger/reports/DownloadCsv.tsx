"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// Downloads exactly the rows the report is showing, already filtered by the
// period and by what the reader's own role may see — the server decided both.
// It adds no data and no access of its own.
export default function DownloadCsv({
  filename,
  headers,
  rows,
}: {
  filename: string;
  headers: string[];
  rows: (string | number | null)[][];
}) {
  const cell = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    // Quote anything with a comma, quote or line break; neutralise a leading
    // = + - @ so a spreadsheet never runs a cell as a formula.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const download = () => {
    const csv = [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={download} disabled={rows.length === 0}>
      <Download className="size-4" /> Download CSV
    </Button>
  );
}
