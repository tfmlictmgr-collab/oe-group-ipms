import { parseCsv } from "./asset-schema";

// Bulk unit entry.
//
// A block of 40 flats is not going to be typed in one at a time, and the
// apportionment factor is the number that decides what each of them pays — so
// this validates hard and reports per row, rather than importing what it can and
// leaving the rest to be discovered on the first invoice run.
//
// Everything is checked BEFORE anything is written. A half-imported block is
// worse than a refused one: the budget apportions across whatever exists, so a
// missing unit quietly inflates every other unit's share.

export type UnitIssue = { column: string; message: string };

export type ValidatedUnit = {
  rowNumber: number;
  raw: Record<string, string>;
  values: {
    label: string;
    apportionment_factor: number;
    occupant_email: string | null;
  } | null;
  issues: UnitIssue[];
  /** Same label as another row in this file, or already on the property. */
  duplicate: boolean;
  valid: boolean;
};

export const UNIT_COLUMNS = [
  {
    key: "label",
    label: "Unit",
    required: true,
    hint: "REQUIRED — how the unit is known: Flat 2, Suite 3B, Shop 14.",
    example: "Flat 2",
  },
  {
    key: "apportionment_factor",
    label: "Apportionment factor",
    required: true,
    hint: "REQUIRED — the unit's share weighting. Floor area in sqm is the usual choice. Must be greater than zero.",
    example: "85.5",
  },
  {
    key: "occupant_email",
    label: "Occupant email",
    required: false,
    hint: "optional — an existing member's email. Leave blank and assign later.",
    example: "tenant@example.com",
  },
] as const;

export function buildUnitTemplateCsv(): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    UNIT_COLUMNS.map((c) => cell(c.key)).join(","),
    UNIT_COLUMNS.map((c, i) => cell(`${i === 0 ? "# " : ""}${c.hint}`)).join(","),
    UNIT_COLUMNS.map((c) => cell(c.example)).join(","),
  ].join("\n");
}

export function validateUnitCsv(
  text: string,
  ctx: { existingLabels: Set<string>; memberEmails: Set<string> }
): { rows: ValidatedUnit[]; headerIssues: string[] } {
  const parsed = parseCsv(text);
  const headerIssues: string[] = [];

  if (parsed.length === 0) {
    return { rows: [], headerIssues: ["The file appears to be empty."] };
  }

  const header = parsed[0].map((h) => h.trim().toLowerCase());
  for (const c of UNIT_COLUMNS) {
    if (c.required && !header.includes(c.key)) {
      headerIssues.push(`Missing required column "${c.key}".`);
    }
  }
  if (headerIssues.length > 0) return { rows: [], headerIssues };

  const seenInFile = new Set<string>();
  const rows: ValidatedUnit[] = [];

  for (let i = 1; i < parsed.length; i++) {
    const cells = parsed[i];
    // The template's guidance line, and blank rows from a spreadsheet export.
    if (cells.every((c) => !c.trim())) continue;
    if (cells[0]?.trim().startsWith("#")) continue;

    const raw: Record<string, string> = {};
    header.forEach((h, n) => { raw[h] = (cells[n] ?? "").trim(); });

    const issues: UnitIssue[] = [];
    const label = raw.label ?? "";
    if (!label) issues.push({ column: "label", message: "A unit needs a label." });

    // Accept "1,250.00" and "1 250" — a factor copied from a spreadsheet often
    // carries its formatting, and rejecting that is pedantry, not validation.
    const rawFactor = (raw.apportionment_factor ?? "").replace(/[,\s]/g, "");
    const factor = Number(rawFactor);
    if (!rawFactor) {
      issues.push({ column: "apportionment_factor", message: "An apportionment factor is required." });
    } else if (!Number.isFinite(factor)) {
      issues.push({ column: "apportionment_factor", message: `"${raw.apportionment_factor}" is not a number.` });
    } else if (factor <= 0) {
      issues.push({
        column: "apportionment_factor",
        message: "Must be greater than zero — a zero-weighted unit pays nothing and its share falls on its neighbours.",
      });
    }

    const email = (raw.occupant_email ?? "").toLowerCase();
    if (email && !ctx.memberEmails.has(email)) {
      issues.push({
        column: "occupant_email",
        message: `No member with the email "${raw.occupant_email}". Invite them first, or leave this blank and assign later.`,
      });
    }

    const key = label.toLowerCase();
    const duplicate = Boolean(key) && (seenInFile.has(key) || ctx.existingLabels.has(key));
    if (duplicate) {
      issues.push({
        column: "label",
        message: seenInFile.has(key)
          ? "This label appears twice in the file."
          : "A unit with this label already exists on the property.",
      });
    }
    if (key) seenInFile.add(key);

    const valid = issues.length === 0;
    rows.push({
      rowNumber: i + 1,
      raw,
      values: valid
        ? { label, apportionment_factor: factor, occupant_email: email || null }
        : null,
      issues,
      duplicate,
      valid,
    });
  }

  return { rows, headerIssues };
}

/**
 * What each unit would pay of a given budget, on the factors as entered.
 *
 * Shown in the preview because an apportionment mistake is invisible as a
 * number and obvious as a percentage — a unit weighted 850 among neighbours
 * weighted 85 reads as fine until you see it carrying half the building.
 */
export function previewShares(
  rows: ValidatedUnit[]
): { label: string; factor: number; pct: number }[] {
  const usable = rows.filter((r) => r.valid && r.values);
  const total = usable.reduce((s, r) => s + r.values!.apportionment_factor, 0);
  if (total <= 0) return [];
  return usable.map((r) => ({
    label: r.values!.label,
    factor: r.values!.apportionment_factor,
    pct: (r.values!.apportionment_factor / total) * 100,
  }));
}
