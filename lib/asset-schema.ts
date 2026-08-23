// Single source of truth for the asset register's importable shape.
// The CSV template, the bulk-import validator and the single-entry form all read
// from here, so a field can never be offered in one place and rejected in another.

export const ASSET_CATEGORIES = [
  "hvac",
  "electrical",
  "power_generation",
  "plumbing",
  "fire_safety",
  "security",
  "lifts_escalators",
  "building_fabric",
  "furniture_fittings",
  "it_communications",
  "grounds_external",
  "cleaning_waste",
  "other",
] as const;

export const ASSET_CONDITIONS = ["new", "good", "fair", "poor", "unserviceable"] as const;
export const ASSET_CRITICALITIES = ["critical", "high", "medium", "low"] as const;
export const ASSET_STATUSES = [
  "in_service",
  "under_maintenance",
  "standby",
  "decommissioned",
  "disposed",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type FieldType = "text" | "enum" | "date" | "number" | "boolean";

/** 0121. `usage` is a Phase-2 seam: valid in the database so the column never
 *  needs widening when meters/sensor_readings land.
 *
 *  ⚠️ `usage` is now OFFERED (0187). It was withheld while "nothing can compute
 *  it yet" was true; what it actually needed was three columns and a place to
 *  type the number painted on the front of the generator, not the Phase-2 IoT
 *  integration it was waiting behind. A 500-hour service interval is six weeks
 *  of grid instability or nine months of standby duty, and a calendar cannot
 *  tell those apart. */
export const MAINTENANCE_STRATEGIES = ["reactive", "calendar", "usage"] as const;
/**
 * What an asset serves (decision 8). `site` is offered but never guessed on
 * import: nothing in a spreadsheet distinguishes "serves this building" from
 * "serves the whole site", so it has to be said.
 */
export const ASSET_SCOPES = ["unit", "property", "site"] as const;

export const ASSET_MOBILITIES = ["fixed", "movable"] as const;

export type AssetField = {
  /** CSV column header — also the DB column name. */
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  enumValues?: readonly string[];
  /** Shown in the template's guidance row. */
  hint: string;
  /** Example value in the template's sample row. */
  example: string;
  group: "identity" | "location" | "lifecycle" | "commercial" | "responsibility" | "compliance" | "insurance";
};

// Only property, tag and name are mandatory — a quick register stays valid, and
// compliance/insurance detail can be filled in later.
export const ASSET_FIELDS: AssetField[] = [
  // Identity
  { key: "asset_tag", label: "Asset tag", type: "text", required: true, group: "identity",
    hint: "Your unique reference. Must not already exist.", example: "GEN-IKJ-001" },
  { key: "name", label: "Asset name", type: "text", required: true, group: "identity",
    hint: "What it is, in plain words.", example: "Perkins 250kVA Generator" },
  { key: "category", label: "Category", type: "enum", enumValues: ASSET_CATEGORIES, group: "identity",
    hint: "One of the listed values. Defaults to 'other'.", example: "power_generation" },
  { key: "description", label: "Description", type: "text", group: "identity",
    hint: "Optional free text.", example: "Standby generator serving the whole building" },
  { key: "manufacturer", label: "Manufacturer", type: "text", group: "identity",
    hint: "Make.", example: "Perkins" },
  { key: "model", label: "Model", type: "text", group: "identity",
    hint: "Model number.", example: "2506A-E15" },
  { key: "serial_number", label: "Serial number", type: "text", group: "identity",
    hint: "Manufacturer serial.", example: "8841207" },

  // Location
  { key: "property_name", label: "Property", type: "text", required: true, group: "location",
    hint: "Must match a property you manage, exactly.", example: "Ikoyi Court" },
  { key: "unit_label", label: "Unit", type: "text", group: "location",
    hint: "Required when scope is 'unit'. Leave blank for shared plant.", example: "" },
  // ⚠️ Placed BEFORE the unit field would have been read, and worded as a
  // statement rather than an absence. Decision 8: "shared" is a stated fact,
  // never an empty Unit column — a blank unit used to mean three different
  // things at once (building-wide plant, site-wide plant, and a row someone
  // had not finished filling in), and no query could tell them apart.
  { key: "scope", label: "Serves", type: "enum",
    enumValues: ASSET_SCOPES, group: "location",
    hint: "unit: this unit only (name the Unit). property: shared across the building. site: shared across the site.",
    example: "property" },
  { key: "location_detail", label: "Location detail", type: "text", group: "location",
    hint: "Where to physically find it.", example: "Roof plant room, Level 3" },
  { key: "mobility", label: "Fixed or movable", type: "enum",
    enumValues: ASSET_MOBILITIES, group: "location",
    hint: "fixed: structurally part of this property. movable: may transfer between properties.",
    example: "fixed" },

  // Lifecycle
  { key: "status", label: "Status", type: "enum", enumValues: ASSET_STATUSES, group: "lifecycle",
    hint: "Defaults to in_service.", example: "in_service" },
  { key: "condition", label: "Condition", type: "enum", enumValues: ASSET_CONDITIONS, group: "lifecycle",
    hint: "Defaults to good.", example: "good" },
  { key: "criticality", label: "Criticality", type: "enum", enumValues: ASSET_CRITICALITIES, group: "lifecycle",
    hint: "Drives maintenance priority. Defaults to medium.", example: "critical" },
  { key: "purchase_date", label: "Purchase date", type: "date", group: "lifecycle",
    hint: "YYYY-MM-DD.", example: "2023-04-12" },
  { key: "commissioned_date", label: "Commissioned date", type: "date", group: "lifecycle",
    hint: "YYYY-MM-DD.", example: "2023-05-02" },
  { key: "warranty_expiry", label: "Warranty expiry", type: "date", group: "lifecycle",
    hint: "YYYY-MM-DD.", example: "2026-05-01" },
  { key: "expected_life_years", label: "Expected life (years)", type: "number", group: "lifecycle",
    hint: "Whole number.", example: "15" },
  { key: "last_serviced_at", label: "Last serviced", type: "date", group: "lifecycle",
    hint: "YYYY-MM-DD.", example: "2026-02-03" },
  { key: "next_service_due", label: "Next service due", type: "date", group: "lifecycle",
    hint: "YYYY-MM-DD.", example: "2026-08-03" },
  { key: "maintenance_strategy", label: "Maintenance strategy", type: "enum",
    enumValues: MAINTENANCE_STRATEGIES, group: "lifecycle",
    hint: "How servicing is triggered. Defaults to reactive (on failure).",
    example: "calendar" },
  { key: "service_interval_days", label: "Service interval (days)", type: "number",
    group: "lifecycle",
    hint: "Required when the strategy is calendar; leave blank otherwise.",
    example: "90" },
  { key: "service_interval_hours", label: "Service interval (running hours)",
    type: "number", group: "lifecycle",
    hint: "Required when the strategy is usage — a generator serviced every 500 hours. Leave blank otherwise.",
    example: "500" },
  { key: "running_hours", label: "Hour-meter reading", type: "number",
    group: "lifecycle",
    hint: "What the hour meter reads now. Only counts up — corrections go through the asset's own meter entry, which refuses a reading below the last one.",
    example: "1240.5" },
  { key: "last_service_running_hours", label: "Meter at last service",
    type: "number", group: "lifecycle",
    hint: "What the meter read when it was last serviced — the point the next interval counts from.",
    example: "1000" },

  // Commercial
  { key: "purchase_cost", label: "Purchase cost (NGN)", type: "number", group: "commercial",
    hint: "Numbers only, no currency symbol or commas.", example: "18500000" },
  { key: "replacement_cost", label: "Replacement cost (NGN)", type: "number", group: "commercial",
    hint: "Numbers only.", example: "24000000" },

  // Responsibility
  { key: "vendor_name", label: "Maintaining vendor", type: "text", group: "responsibility",
    hint: "Must match a vendor on record, or leave blank.", example: "PowerGen Services Ltd" },
  { key: "custodian_email", label: "Custodian email", type: "text", group: "responsibility",
    hint: "Email of the in-house person accountable.", example: "fm@oegroup.test" },

  // Compliance (all optional)
  { key: "compliance_required", label: "Compliance required", type: "boolean", group: "compliance",
    hint: "yes / no. Defaults to no.", example: "yes" },
  { key: "regulatory_standard", label: "Regulatory standard", type: "text", group: "compliance",
    hint: "e.g. SON, NFPA 10, LOLER.", example: "SON" },
  { key: "certifying_body", label: "Certifying body", type: "text", group: "compliance",
    hint: "Who inspects or certifies.", example: "Lagos State Fire Service" },
  { key: "certificate_number", label: "Certificate number", type: "text", group: "compliance",
    hint: "Reference on the certificate.", example: "LSFS/2026/4417" },
  { key: "certificate_expiry", label: "Certificate expiry", type: "date", group: "compliance",
    hint: "YYYY-MM-DD. Drives expiry alerts.", example: "2026-08-12" },
  { key: "last_inspection_date", label: "Last inspection", type: "date", group: "compliance",
    hint: "YYYY-MM-DD.", example: "2025-08-12" },
  { key: "next_inspection_due", label: "Next inspection due", type: "date", group: "compliance",
    hint: "YYYY-MM-DD.", example: "2026-08-12" },

  // Insurance (all optional)
  { key: "insurer_name", label: "Insurer", type: "text", group: "insurance",
    hint: "Insurance company.", example: "Leadway Assurance" },
  { key: "insurance_policy_no", label: "Policy number", type: "text", group: "insurance",
    hint: "Policy reference.", example: "LW-PL-99231" },
  { key: "insured_value", label: "Insured value (NGN)", type: "number", group: "insurance",
    hint: "Numbers only.", example: "20000000" },
  { key: "insurance_expiry", label: "Insurance expiry", type: "date", group: "insurance",
    hint: "YYYY-MM-DD. Drives expiry alerts.", example: "2026-12-31" },

  { key: "notes", label: "Notes", type: "text", group: "identity",
    hint: "Anything else worth recording.", example: "Serves Blocks A and B" },
];

export const GROUP_LABELS: Record<AssetField["group"], string> = {
  identity: "Identity",
  location: "Location",
  lifecycle: "Lifecycle & condition",
  commercial: "Commercial",
  responsibility: "Responsibility",
  compliance: "Compliance",
  insurance: "Insurance",
};

// ── CSV helpers ────────────────────────────────────────────────────────────

/** Quotes a value for CSV: doubles internal quotes, wraps when needed. */
export function csvCell(value: string): string {
  if (value === "") return "";
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * The downloadable template: a header row, a guidance row explaining each
 * column, and one worked example. Guidance/example rows are prefixed with '#'
 * in the first column so the importer skips them if left in by mistake.
 */
export function buildTemplateCsv(customFieldKeys: string[] = []): string {
  const keys = [...ASSET_FIELDS.map((f) => f.key), ...customFieldKeys];
  const header = keys.map(csvCell).join(",");

  const guidance = [
    ...ASSET_FIELDS.map((f) =>
      csvCell(`${f.required ? "REQUIRED — " : "optional — "}${f.hint}`)
    ),
    ...customFieldKeys.map(() => csvCell("optional — custom field")),
  ];
  guidance[0] = csvCell(`# ${ASSET_FIELDS[0].required ? "REQUIRED — " : ""}${ASSET_FIELDS[0].hint}`);

  const example = [
    ...ASSET_FIELDS.map((f) => csvCell(f.example)),
    ...customFieldKeys.map(() => ""),
  ];
  example[0] = csvCell(`# ${ASSET_FIELDS[0].example}`);

  // CRLF + BOM so Excel opens it cleanly with correct encoding.
  return "﻿" + [header, guidance.join(","), example.join(",")].join("\r\n") + "\r\n";
}

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
