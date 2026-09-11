import { parseCsvLines } from "./csv";

/**
 * The bulk importer for the tenancy schedule (0265).
 *
 * The schedule is `MANAGEMENT PORTFOLIO.xlsx` rendered live, and this is how a
 * portfolio that is already let gets into it. Its columns are the workbook's
 * own, deliberately — somebody pasting a sheet into the template should not
 * have to translate their own headings.
 *
 * ⚠️ Pure. No I/O, so the SAME validator runs in the preview and again at
 * commit — the preview can never promise something the write would reject. That
 * is the asset importer's rule and this follows it rather than inventing a
 * second shape.
 *
 * ⚠️ What is deliberately NOT importable: rent billed, rent collected,
 * management fees, landlord net, service charge. Every one of those is DERIVED
 * from the ledger by `tenancy_schedule`, and a column here would be a second
 * place for a figure the ledger already owns — they would disagree the first
 * time somebody corrected one of them. The workbook carries them because a
 * spreadsheet has no ledger; this product does.
 */

export type Column = {
  key: string;
  label: string;
  required?: boolean;
  hint: string;
  example: string;
};

export const TENANCY_COLUMNS: Column[] = [
  { key: "property_name", label: "Property", required: true,
    hint: "Must match a property you manage, exactly.", example: "Osborne Towers" },
  { key: "unit_label", label: "Unit", required: true,
    hint: "The unit as it is labelled on that property.", example: "Flat 4" },
  { key: "tenant_name", label: "Name of tenant", required: true,
    hint: "The tenant of record. They do not need a portal account.", example: "Adaeze Okonkwo" },
  { key: "tenant_phone", label: "Phone",
    hint: "Optional. Carried onto the schedule as the workbook does.", example: "+2348012345678" },
  { key: "tenant_email", label: "Tenant email",
    hint: "Optional. If it matches an existing tenant account, the tenancy is linked to it.", example: "adaeze@example.com" },
  { key: "start_date", label: "Term starts", required: true,
    hint: "YYYY-MM-DD.", example: "2026-01-01" },
  { key: "end_date", label: "Term ends", required: true,
    hint: "YYYY-MM-DD. Must be after the start.", example: "2026-12-31" },
  { key: "rent_amount", label: "Rent per annum", required: true,
    hint: "Figures only — commas and ₦ are fine.", example: "4,500,000" },
  { key: "deposit_amount", label: "Deposit",
    hint: "Optional. Zero if not held.", example: "450000" },
  { key: "escalation_pct", label: "Escalation %",
    hint: "Optional, 0–100. Applied on renewal, never to this term.", example: "5" },
  { key: "status", label: "Status",
    hint: "active (default) or draft. An active tenancy occupies its unit.", example: "active" },
  { key: "remark", label: "Remark",
    hint: "Optional. The workbook's REMARK column.", example: "Paid and remitted" },
];

export type RowIssue = { column: string; message: string };

export type ValidatedRow = {
  /** 1-based PHYSICAL line in the user's file, so "row 7" means row 7. */
  rowNumber: number;
  raw: Record<string, string>;
  /** Ready for `import_tenancies`. */
  values: Record<string, unknown>;
  /** For the preview table, resolved rather than raw. */
  display: {
    property: string; unit: string; tenant: string;
    term: string; rent: string; status: string;
  };
  issues: RowIssue[];
  valid: boolean;
};

export type ImportContext = {
  /** Properties the caller may WRITE to: lowercase name -> id. */
  propertiesByName: Map<string, string>;
  /**
   * Names shared by more than one writable property.
   *
   * ⚠️ Kept separately because `propertiesByName` cannot express it — a Map
   * holds one value per key, so the second property of a given name overwrites
   * the first and the collision becomes invisible at exactly the moment it
   * matters. The asset importer learned this on a demo portfolio with two
   * "Lekki Gardens Estate", and a tenancy filed against the wrong building is
   * worse than an asset filed against one: it bills a real person.
   */
  ambiguousPropertyNames: Set<string>;
  /** Units of those properties: "propertyId::lowercase label" -> unit id. */
  unitsByKey: Map<string, string>;
  /** Tenant accounts in the org: lowercase email -> id. */
  tenantsByEmail: Map<string, string>;
  /**
   * Live tenancies already on a unit: unit id -> [start, end) ranges.
   *
   * ⚠️ `leases_no_overlap` only excludes where the status is active/renewed, so
   * a DRAFT import would sail past it and produce a silent duplicate — the
   * constraint cannot be relied on to make a re-upload idempotent. Checked here
   * so a second upload of the same sheet reports "already recorded" instead of
   * doubling the rent roll.
   */
  occupiedRanges: Map<string, { start: string; end: string }[]>;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Figures as a person types them: "₦4,500,000.00", "4500000", "4,500,000". */
function money(raw: string): number | null {
  const cleaned = raw.replace(/[₦,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Half-open, matching `daterange(start, end, '[)')` — the constraint's own rule. */
function overlaps(a: { start: string; end: string }, b: { start: string; end: string }) {
  return a.start < b.end && b.start < a.end;
}

export function validateTenancyCsv(
  text: string,
  ctx: ImportContext
): { rows: ValidatedRow[]; headerIssues: string[] } {
  const grid = parseCsvLines(text);
  const headerIssues: string[] = [];
  if (grid.length === 0) return { rows: [], headerIssues: ["The file is empty."] };

  const header = grid[0].cells.map((h) => h.trim().toLowerCase());
  const known = new Set(TENANCY_COLUMNS.map((c) => c.key));
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length > 0) {
    headerIssues.push(`Ignoring unrecognised column(s): ${unknown.join(", ")}`);
  }
  for (const c of TENANCY_COLUMNS.filter((x) => x.required)) {
    if (!header.includes(c.key)) headerIssues.push(`Missing required column "${c.key}".`);
  }

  // A file can collide with ITSELF — two rows letting the same unit over
  // overlapping dates. Checked against what the file has claimed so far as well
  // as against what is already recorded.
  const claimedInFile = new Map<string, { start: string; end: string }[]>();

  // ⚠️ The template's own GUIDANCE row is skipped.
  //
  // The template ships a second line explaining each column, and tells the
  // reader to delete it. Somebody who does not — which is most people the first
  // time — got "You do not manage a property with this name" pointed at a row
  // of instructions, which reads as the importer being broken rather than as a
  // row to remove. Recognised by its content matching the hints exactly, so a
  // real tenancy can never be mistaken for it.
  const guidance = new Set(TENANCY_COLUMNS.map((c) => c.hint));
  const body = grid.slice(1).filter(({ cells }) => {
    const filled = cells.map((c) => c.trim()).filter(Boolean);
    return filled.length === 0 || !filled.every((c) => guidance.has(c));
  });

  const rows: ValidatedRow[] = body.map(({ cells, line }) => {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { if (h) raw[h] = (cells[i] ?? "").trim(); });

    const issues: RowIssue[] = [];
    const values: Record<string, unknown> = { row: String(line) };

    // ── Property, and it must be one the caller can write to ───────────────
    let propId: string | undefined;
    const propName = raw["property_name"] ?? "";
    if (!propName) {
      issues.push({ column: "property_name", message: "Property is required." });
    } else {
      const key = propName.toLowerCase();
      if (ctx.ambiguousPropertyNames.has(key)) {
        issues.push({
          column: "property_name",
          message:
            `More than one property is called "${propName}". Rename one, or import ` +
            `them separately — this file cannot say which you mean.`,
        });
      } else {
        propId = ctx.propertiesByName.get(key);
        if (!propId) {
          issues.push({
            column: "property_name",
            message: "You do not manage a property with this name.",
          });
        } else values.property_id = propId;
      }
    }

    // ── Unit (required — a tenancy is of a unit, not of a building) ─────────
    const unitLabel = raw["unit_label"] ?? "";
    let unitId: string | undefined;
    if (!unitLabel) {
      issues.push({ column: "unit_label", message: "Unit is required." });
    } else if (propId) {
      unitId = ctx.unitsByKey.get(`${propId}::${unitLabel.toLowerCase()}`);
      if (!unitId) {
        issues.push({
          column: "unit_label",
          message: `No unit "${unitLabel}" on ${propName}. Add it to the property first.`,
        });
      } else values.unit_id = unitId;
    }

    // ── The tenant ─────────────────────────────────────────────────────────
    const tenantName = raw["tenant_name"] ?? "";
    if (!tenantName) {
      issues.push({ column: "tenant_name", message: "The tenant's name is required." });
    } else values.tenant_name = tenantName;
    if (raw["tenant_phone"]) values.tenant_phone = raw["tenant_phone"];

    // An email is optional and only ever LINKS to an account that already
    // exists. It never creates one: bulk-creating identities from a spreadsheet
    // is not an import, and an account nobody asked for is an account nobody
    // secures.
    const email = (raw["tenant_email"] ?? "").toLowerCase();
    if (email) {
      const uid = ctx.tenantsByEmail.get(email);
      if (uid) values.tenant_user_id = uid;
      // Deliberately not an issue when unmatched — the tenancy is still valid
      // and the name carries it. Reported in the preview instead.
    }

    // ── The term ───────────────────────────────────────────────────────────
    const start = raw["start_date"] ?? "";
    const end = raw["end_date"] ?? "";
    if (!DATE_RE.test(start)) {
      issues.push({ column: "start_date", message: "Give the start as YYYY-MM-DD." });
    } else values.start_date = start;
    if (!DATE_RE.test(end)) {
      issues.push({ column: "end_date", message: "Give the end as YYYY-MM-DD." });
    } else values.end_date = end;
    if (DATE_RE.test(start) && DATE_RE.test(end) && end <= start) {
      issues.push({ column: "end_date", message: "The term has to end after it starts." });
    }

    // ── Rent, and the optional figures ─────────────────────────────────────
    const rent = money(raw["rent_amount"] ?? "");
    if (rent === null) {
      issues.push({ column: "rent_amount", message: "Give the rent as a number." });
    } else if (rent <= 0) {
      issues.push({ column: "rent_amount", message: "The rent has to be greater than zero." });
    } else values.rent_amount = rent;

    const deposit = raw["deposit_amount"] ? money(raw["deposit_amount"]) : 0;
    if (deposit === null || deposit < 0) {
      issues.push({ column: "deposit_amount", message: "The deposit must be zero or more." });
    } else values.deposit_amount = deposit;

    const esc = raw["escalation_pct"] ? money(raw["escalation_pct"]) : 0;
    if (esc === null || esc < 0 || esc > 100) {
      issues.push({ column: "escalation_pct", message: "The escalation must be between 0 and 100." });
    } else values.escalation_pct = esc;

    // ── Status ─────────────────────────────────────────────────────────────
    const status = (raw["status"] ?? "").toLowerCase() || "active";
    if (!["active", "draft"].includes(status)) {
      issues.push({
        column: "status",
        message: `"${raw["status"]}" is not a status. Use active or draft.`,
      });
    } else {
      // Everything is inserted as a draft and ACTIVATED, never written active —
      // see the migration. This flag is what asks for that second step.
      values.activate = status === "active";
    }

    if (raw["remark"]) values.remark = raw["remark"];

    // ── Is that unit already let over those dates? ─────────────────────────
    if (unitId && DATE_RE.test(start) && DATE_RE.test(end) && end > start) {
      const range = { start, end };
      const already = ctx.occupiedRanges.get(unitId) ?? [];
      if (already.some((r) => overlaps(range, r))) {
        issues.push({
          column: "unit_label",
          message:
            `${unitLabel} is already let over those dates. If you are re-uploading ` +
            `a sheet, this row is already recorded — remove it.`,
        });
      } else {
        const inFile = claimedInFile.get(unitId) ?? [];
        if (inFile.some((r) => overlaps(range, r))) {
          issues.push({
            column: "unit_label",
            message: "Another row in this file already lets that unit over those dates.",
          });
        } else {
          inFile.push(range);
          claimedInFile.set(unitId, inFile);
        }
      }
    }

    return {
      rowNumber: line,
      raw,
      values,
      display: {
        property: propName || "—",
        unit: unitLabel || "—",
        tenant: tenantName || "—",
        term: start && end ? `${start} → ${end}` : "—",
        rent: rent !== null ? `₦${rent.toLocaleString("en-NG")}` : (raw["rent_amount"] || "—"),
        status,
      },
      issues,
      valid: issues.length === 0,
    };
  });

  return { rows, headerIssues };
}

/** The template a person downloads, fills in, and uploads back. */
export function tenancyTemplateCsv(propertyNames: string[]): string {
  const header = TENANCY_COLUMNS.map((c) => c.key).join(",");
  const guidance = TENANCY_COLUMNS.map((c) => `"${c.hint.replace(/"/g, '""')}"`).join(",");
  const example = TENANCY_COLUMNS.map((c) => `"${c.example}"`).join(",");
  const notes = [
    "# Tenancy schedule import.",
    "# Delete these # lines and the guidance row before uploading, or leave them — both are ignored.",
    "# Rent billed, rent collected, management fee and service charge are NOT imported:",
    "# they are worked out from the ledger, so a column here would be a second set of figures.",
    propertyNames.length
      ? `# Properties you can import to: ${propertyNames.slice(0, 40).join(" | ")}`
      : "# You are not attached to any property, so there is nothing to import to yet.",
  ].join("\r\n");
  // A BOM, so Excel opens it as UTF-8 rather than mangling a naira sign.
  return "﻿" + [notes, header, guidance, example].join("\r\n") + "\r\n";
}
