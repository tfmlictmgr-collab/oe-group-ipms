import { parseCsvLines } from "./asset-schema";
import { effectiveFactor } from "./apportionment";

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
    /** 0198 — how many units this row stands for. Defaults to 1 when absent. */
    unit_quantity: number;
    description: string | null;
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
    label: "Type",
    required: true,
    hint: "REQUIRED — what this unit is: Terrace, Stall, Office Suite. Anything not already on the property's list is added to it.",
    example: "Terrace",
  },
  {
    key: "apportionment_factor",
    label: "Occupied space (m2)",
    required: true,
    hint: "REQUIRED — occupied space in square metres, PER unit. Decides this unit's share of the service charge. Must be greater than zero.",
    example: "85.5",
  },
  {
    key: "unit_quantity",
    label: "Units",
    required: false,
    hint: "optional — how many units this row stands for (12 stalls). Leave blank for 1. The space above is PER unit.",
    example: "1",
  },
  {
    key: "description",
    label: "Description",
    required: false,
    hint: "optional — a note to tell two rows of the same type apart: Block A, ground floor.",
    example: "",
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
  const parsed = parseCsvLines(text);
  const headerIssues: string[] = [];

  if (parsed.length === 0) {
    return { rows: [], headerIssues: ["The file appears to be empty."] };
  }

  const header = parsed[0].cells.map((h) => h.trim().toLowerCase());
  for (const c of UNIT_COLUMNS) {
    if (c.required && !header.includes(c.key)) {
      headerIssues.push(`Missing required column "${c.key}".`);
    }
  }
  if (headerIssues.length > 0) return { rows: [], headerIssues };

  const seenInFile = new Set<string>();
  const rows: ValidatedUnit[] = [];

  for (let i = 1; i < parsed.length; i++) {
    const { cells, line } = parsed[i];
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

    // Quantity: blank means 1, which is the ordinary single flat. Rejected
    // rather than rounded when it is fractional — half a stall is a typo, and
    // guessing which way it was meant is how a bill goes wrong quietly.
    const rawQty = (raw.unit_quantity ?? "").replace(/[,\s]/g, "");
    let quantity = 1;
    if (rawQty) {
      const n = Number(rawQty);
      if (!Number.isFinite(n)) {
        issues.push({ column: "unit_quantity", message: `"${raw.unit_quantity}" is not a number.` });
      } else if (!Number.isInteger(n)) {
        issues.push({ column: "unit_quantity", message: "Must be a whole number — you cannot let a third of a stall." });
      } else if (n < 1) {
        issues.push({ column: "unit_quantity", message: "Must be at least 1." });
      } else {
        quantity = n;
      }
    }

    const description = (raw.description ?? "") || null;

    const email = (raw.occupant_email ?? "").toLowerCase();
    if (email && !ctx.memberEmails.has(email)) {
      issues.push({
        column: "occupant_email",
        message: `No member with the email "${raw.occupant_email}". Invite them first, or leave this blank and assign later.`,
      });
    }

    // ⚠️ This key mirrors `units_property_label_desc_uidx` (0198) exactly:
    // (property, lower(label), lower(coalesce(description,''))). If the two
    // ever drift, the preview reports a clean import and the database refuses
    // it — the failure this whole module exists to prevent, moved one step
    // later. Two rows of the same type are legitimate; two IDENTICAL ones are
    // what silently doubles a property's share.
    const key = `${label.toLowerCase()}|${(description ?? "").toLowerCase()}`;
    const duplicate = Boolean(label) && (seenInFile.has(key) || ctx.existingLabels.has(key));
    if (duplicate) {
      issues.push({
        column: "label",
        message: seenInFile.has(key)
          ? "This type and description appear twice in the file — give one of them a description that tells them apart."
          : "A unit of this type and description already exists on the property.",
      });
    }
    if (label) seenInFile.add(key);

    const valid = issues.length === 0;
    rows.push({
      rowNumber: line,
      raw,
      values: valid
        ? { label, apportionment_factor: factor, unit_quantity: quantity, description, occupant_email: email || null }
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
  // ⚠️ Weighted through the SAME `effectiveFactor` the real apportionment uses
  // (0198), imported rather than restated. A preview that computes its own
  // version of the rule is a preview that will one day disagree with the bill.
  const weigh = (r: ValidatedUnit) =>
    effectiveFactor({ factor: r.values!.apportionment_factor, quantity: r.values!.unit_quantity });
  const total = usable.reduce((s, r) => s + weigh(r), 0);
  if (total <= 0) return [];
  return usable.map((r) => ({
    label: r.values!.label,
    factor: weigh(r),
    pct: (weigh(r) / total) * 100,
  }));
}
