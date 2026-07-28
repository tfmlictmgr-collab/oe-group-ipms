import { parseCsvLines, csvCell } from "./asset-schema";

// Bank statement import. Nigerian bank exports vary a lot, so rather than
// guessing at every format the importer accepts a small canonical shape and
// tolerates the two common variants: a single signed `amount`, or separate
// `debit`/`credit` columns.
//
// Amounts are normalised to the account's point of view — money in positive,
// money out negative — which is the same convention as the ledger's asset side,
// so a matched pair compares without sign juggling.

export type StatementIssue = { column: string; message: string };

export type StatementRow = {
  rowNumber: number;
  raw: Record<string, string>;
  values: {
    value_date: string;
    description: string | null;
    reference: string | null;
    amount: number;
    external_id: string | null;
  } | null;
  issues: StatementIssue[];
  /** Same reference already in the file or already imported. Hard block. */
  duplicate: boolean;
  /** Same date+amount+description as another line. A warning, never a block. */
  possibleDuplicate: boolean;
  valid: boolean;
};

export const STATEMENT_COLUMNS = [
  { key: "date", label: "Date", required: true, hint: "YYYY-MM-DD", example: "2026-08-03" },
  { key: "description", label: "Description", required: false, hint: "As it appears on the statement.", example: "TRF FROM ADEYEMI B - RENT" },
  { key: "reference", label: "Reference", required: false, hint: "Your own reference, if any.", example: "INV-2026-0042" },
  { key: "amount", label: "Amount", required: false, hint: "Signed: money in positive, money out negative. Use this OR debit/credit.", example: "1200000" },
  { key: "debit", label: "Debit", required: false, hint: "Money OUT. Use with credit instead of amount.", example: "" },
  { key: "credit", label: "Credit", required: false, hint: "Money IN. Use with debit instead of amount.", example: "1200000" },
  { key: "external_id", label: "Bank reference", required: false, hint: "The bank's own unique id. Supplying it makes re-importing safe.", example: "FT26216XYZ01" },
] as const;

export function buildStatementTemplateCsv(): string {
  const header = STATEMENT_COLUMNS.map((c) => csvCell(c.key)).join(",");
  const guidance = STATEMENT_COLUMNS.map((c, i) =>
    csvCell(`${i === 0 ? "# " : ""}${c.required ? "REQUIRED — " : "optional — "}${c.hint}`)
  ).join(",");
  const example = STATEMENT_COLUMNS.map((c, i) =>
    csvCell(`${i === 0 ? "# " : ""}${c.example}`)
  ).join(",");
  return "﻿" + [header, guidance, example].join("\r\n") + "\r\n";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts "1,200,000", "₦1200000", "(1200)" for negatives, and plain numbers. */
function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[₦,\s]/g, "");
  if (!s) return null;
  let negative = false;
  // Accounting notation: parentheses mean a negative.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function validateStatementCsv(
  text: string,
  existingExternalIds: Set<string>
): { rows: StatementRow[]; headerIssues: string[] } {
  const grid = parseCsvLines(text);
  const headerIssues: string[] = [];
  if (grid.length === 0) return { rows: [], headerIssues: ["The file is empty."] };

  const header = grid[0].cells.map((h) => h.trim().toLowerCase());
  const known = new Set(STATEMENT_COLUMNS.map((c) => c.key));
  const unknown = header.filter((h) => h && !known.has(h as never));
  if (unknown.length) headerIssues.push(`Ignoring unrecognised column(s): ${unknown.join(", ")}`);
  if (!header.includes("date")) headerIssues.push('Missing required column "date".');
  if (!header.includes("amount") && !header.includes("debit") && !header.includes("credit")) {
    headerIssues.push('Provide an "amount" column, or "debit" and "credit" columns.');
  }

  const seenRefs = new Set<string>();
  const seenFingerprints = new Map<string, number>();

  const rows: StatementRow[] = grid.slice(1).map(({ cells, line }) => {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { if (h) raw[h] = (cells[i] ?? "").trim(); });

    const issues: StatementIssue[] = [];
    let duplicate = false;
    let possibleDuplicate = false;

    // Date
    const date = raw.date ?? "";
    if (!date) issues.push({ column: "date", message: "Date is required." });
    else if (!DATE_RE.test(date)) issues.push({ column: "date", message: `Use YYYY-MM-DD (got "${date}").` });
    else if (Number.isNaN(Date.parse(date))) issues.push({ column: "date", message: `"${date}" is not a real date.` });

    // Amount: either signed, or debit/credit.
    let amount: number | null = null;
    if (raw.amount) {
      amount = parseAmount(raw.amount);
      if (amount === null) issues.push({ column: "amount", message: `Not a number: "${raw.amount}".` });
    } else {
      const debit = raw.debit ? parseAmount(raw.debit) : null;
      const credit = raw.credit ? parseAmount(raw.credit) : null;
      if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
        issues.push({ column: "debit", message: "A line cannot be both a debit and a credit." });
      } else if (credit !== null && credit !== 0) {
        amount = Math.abs(credit);          // money in
      } else if (debit !== null && debit !== 0) {
        amount = -Math.abs(debit);          // money out
      }
    }
    if (amount === null) {
      issues.push({ column: "amount", message: "Give an amount, or a debit or credit value." });
    } else if (amount === 0) {
      issues.push({ column: "amount", message: "A zero-value line has nothing to reconcile." });
    }

    // Bank reference — the reliable dedupe key.
    const externalId = raw.external_id || null;
    if (externalId) {
      const key = externalId.toLowerCase();
      if (existingExternalIds.has(key)) {
        duplicate = true;
        issues.push({ column: "external_id", message: "Already imported — this line is in the system." });
      } else if (seenRefs.has(key)) {
        duplicate = true;
        issues.push({ column: "external_id", message: "Appears more than once in this file." });
      } else {
        seenRefs.add(key);
      }
    } else if (date && amount !== null) {
      // No bank reference: fingerprint as a WARNING only. Two identical charges
      // on one day are legitimate, and silently dropping the second would
      // understate the account — so a person decides, not the importer.
      const fp = `${date}|${amount}|${(raw.description ?? "").toLowerCase()}`;
      const prev = seenFingerprints.get(fp);
      if (prev) possibleDuplicate = true;
      else seenFingerprints.set(fp, line);
    }

    const valid = issues.length === 0;
    return {
      rowNumber: line,   // the line in the bank's export, not our filtered index
      raw,
      values: valid && amount !== null
        ? {
            value_date: date,
            description: raw.description || null,
            reference: raw.reference || null,
            amount,
            external_id: externalId,
          }
        : null,
      issues,
      duplicate,
      possibleDuplicate,
      valid,
    };
  });

  return { rows, headerIssues };
}
