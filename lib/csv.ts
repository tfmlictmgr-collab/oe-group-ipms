/**
 * One CSV parser for the whole product.
 *
 * ⚠️ Lifted out of `lib/asset-schema.ts` unchanged when the tenancy-schedule
 * importer needed it (0265). A second parser is how two importers disagree
 * about a quoted comma, and a generic parser exported from a module named for
 * assets is how the next person writes that second one rather than finding
 * this. `asset-schema` re-exports both names, so every existing caller is
 * untouched.
 */

/** Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas/newlines. */
function parseCsvRaw(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }

  return rows;
}

/** Rows with blank and '#' guidance lines removed. */
export function parseCsv(text: string): string[][] {
  return parseCsvRaw(text).filter(
    (r) => r.some((c) => c.trim() !== "") && !r[0]?.trim().startsWith("#")
  );
}

/**
 * The same parse, but each surviving row carries the line it came from.
 *
 * `parseCsv` filters blank and '#' rows, so a caller counting its own loop index
 * reports a row number that drifts from the user's file — by one for the shipped
 * template alone, and by more for a spreadsheet export with blank lines. An
 * importer that says "row 4 is wrong" about row 6 is worse than saying nothing.
 */
export function parseCsvLines(text: string): { cells: string[]; line: number }[] {
  const src = text.replace(/^﻿/, "");
  const out: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // The PHYSICAL line the current record started on. A quoted field may contain
  // newlines — the parser supports that — so counting records would drift again,
  // which is the very thing this helper exists to prevent.
  let line = 1;
  let recordStart = 1;

  const endRecord = () => {
    row.push(field);
    field = "";
    if (row.some((c) => c.trim() !== "") && !row[0]?.trim().startsWith("#")) {
      out.push({ cells: row, line: recordStart });
    }
    row = [];
    recordStart = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === "\n") line++;      // a newline INSIDE a quoted field
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { line++; endRecord(); continue; }
    field += ch;
  }
  if (field !== "" || row.length > 0) endRecord();

  return out;
}
