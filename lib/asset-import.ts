import {
  ASSET_FIELDS,
  ASSET_CATEGORIES,
  ASSET_CONDITIONS,
  ASSET_CRITICALITIES,
  ASSET_STATUSES,
  parseCsvLines,
} from "./asset-schema";

// Pure validation for the bulk importer. No I/O here so it can be unit-tested
// and so the same rules run in the preview and at commit time — the preview can
// never promise something the write would reject.

export type RowIssue = { column: string; message: string };

export type ValidatedRow = {
  rowNumber: number;          // 1-based line in the user's file (header = 1)
  raw: Record<string, string>;
  values: Record<string, unknown>;  // ready for insert (DB column -> value)
  issues: RowIssue[];
  valid: boolean;
};

export type ImportContext = {
  /** Properties the caller may write to: lowercase name -> id. */
  propertiesByName: Map<string, string>;
  /**
   * Names shared by more than one property the caller may write to.
   *
   * Kept separately because `propertiesByName` cannot express it: a Map holds
   * one value per key, so the second property with a given name overwrites the
   * first and the collision becomes invisible at exactly the moment it matters.
   */
  ambiguousPropertyNames?: Set<string>;
  /** Units of those properties: "propertyId::lowercase label" -> unit id. */
  unitsByKey: Map<string, string>;
  /** Vendors in the org: lowercase name -> id. */
  vendorsByName: Map<string, string>;
  /** Users in the org: lowercase email -> id. */
  usersByEmail: Map<string, string>;
  /** Asset tags already in use (lowercase). */
  existingTags: Set<string>;
  /** Custom field keys defined for this org. */
  customFieldKeys: string[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRUTHY = new Set(["yes", "y", "true", "1"]);
const FALSY = new Set(["no", "n", "false", "0", ""]);

const ENUMS: Record<string, readonly string[]> = {
  category: ASSET_CATEGORIES,
  condition: ASSET_CONDITIONS,
  criticality: ASSET_CRITICALITIES,
  status: ASSET_STATUSES,
};

/** Cheap edit-distance suggestion so a typo gets a useful hint, not just "invalid". */
function closest(input: string, options: readonly string[]): string | null {
  const a = input.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const opt of options) {
    const b = opt.toLowerCase();
    // Levenshtein, small strings so the simple DP is fine.
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    const score = dp[a.length][b.length];
    if (score < bestScore) { bestScore = score; best = opt; }
  }
  // Only suggest when it's plausibly a typo rather than a different word.
  return bestScore <= Math.max(2, Math.floor(a.length / 3)) ? best : null;
}

export function validateAssetCsv(text: string, ctx: ImportContext): {
  rows: ValidatedRow[];
  headerIssues: string[];
} {
  const grid = parseCsvLines(text);
  const headerIssues: string[] = [];
  if (grid.length === 0) return { rows: [], headerIssues: ["The file is empty."] };

  const header = grid[0].cells.map((h) => h.trim());
  const known = new Set([...ASSET_FIELDS.map((f) => f.key), ...ctx.customFieldKeys]);
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length > 0) {
    headerIssues.push(`Ignoring unrecognised column(s): ${unknown.join(", ")}`);
  }
  for (const f of ASSET_FIELDS.filter((x) => x.required)) {
    if (!header.includes(f.key)) {
      headerIssues.push(`Missing required column "${f.key}".`);
    }
  }

  // Tags seen earlier in THIS file — a file can collide with itself.
  const seenInFile = new Set<string>();

  const rows: ValidatedRow[] = grid.slice(1).map(({ cells, line }) => {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { if (h) raw[h] = (cells[i] ?? "").trim(); });

    const issues: RowIssue[] = [];
    const values: Record<string, unknown> = {};
    const custom: Record<string, string> = {};

    // ── Property (required, and must be one the caller may write to) ────────
    const propName = raw["property_name"] ?? "";
    if (!propName) {
      issues.push({ column: "property_name", message: "Property is required." });
    } else {
      const key = propName.toLowerCase();
      const propId = ctx.propertiesByName.get(key);

      // ⚠️ Two properties can share a name — the demo portfolio has two "Lekki
      // Gardens Estate" — and this map is keyed by name, so `new Map()` keeps
      // whichever came last and silently discards the other. A row naming that
      // property then imports assets into ONE OF THEM, chosen by row order in
      // an unrelated query.
      //
      // That is worse than a rejection: nobody sees it, and the assets are on
      // the wrong building. So an ambiguous name is refused and says why.
      if (ctx.ambiguousPropertyNames?.has(key)) {
        issues.push({
          column: "property_name",
          message:
            `More than one property is called "${propName}". Rename one, or import ` +
            `to them separately — this file cannot say which you mean.`,
        });
      } else if (!propId) {
        issues.push({
          column: "property_name",
          message: "You do not manage a property with this name.",
        });
      } else {
        values.property_id = propId;

        // Unit is optional, but if given must belong to that property.
        const unitLabel = raw["unit_label"] ?? "";
        if (unitLabel) {
          const unitId = ctx.unitsByKey.get(`${propId}::${unitLabel.toLowerCase()}`);
          if (!unitId) {
            issues.push({
              column: "unit_label",
              message: `No unit "${unitLabel}" on ${propName}.`,
            });
          } else values.unit_id = unitId;
        }
      }
    }

    // ── Tag (required, unique per org and within the file) ──────────────────
    const tag = raw["asset_tag"] ?? "";
    if (!tag) {
      issues.push({ column: "asset_tag", message: "Asset tag is required." });
    } else if (ctx.existingTags.has(tag.toLowerCase())) {
      issues.push({ column: "asset_tag", message: "Tag already exists in this organisation." });
    } else if (seenInFile.has(tag.toLowerCase())) {
      issues.push({ column: "asset_tag", message: "Tag appears more than once in this file." });
    } else {
      seenInFile.add(tag.toLowerCase());
      values.asset_tag = tag;
    }

    // ── Name (required) ────────────────────────────────────────────────────
    if (!raw["name"]) issues.push({ column: "name", message: "Asset name is required." });
    else values.name = raw["name"];

    // ── Everything else, by declared type ──────────────────────────────────
    for (const f of ASSET_FIELDS) {
      if (["asset_tag", "name", "property_name", "unit_label"].includes(f.key)) continue;
      const v = raw[f.key];
      if (v == null || v === "") continue;

      if (f.type === "enum") {
        const opts = ENUMS[f.key] ?? f.enumValues ?? [];
        const norm = v.toLowerCase().replace(/[\s-]+/g, "_");
        if (opts.includes(norm)) values[f.key] = norm;
        else {
          const hint = closest(norm, opts);
          issues.push({
            column: f.key,
            message: `Unknown value "${v}"${hint ? ` — did you mean "${hint}"?` : ""}`,
          });
        }
      } else if (f.type === "date") {
        if (!DATE_RE.test(v)) {
          issues.push({ column: f.key, message: `Use YYYY-MM-DD (got "${v}").` });
        } else if (Number.isNaN(Date.parse(v))) {
          issues.push({ column: f.key, message: `"${v}" is not a real date.` });
        } else values[f.key] = v;
      } else if (f.type === "number") {
        const cleaned = v.replace(/[,\s₦]/g, "");
        const n = Number(cleaned);
        if (!Number.isFinite(n) || n < 0) {
          issues.push({ column: f.key, message: `Expected a positive number (got "${v}").` });
        } else if (f.key === "expected_life_years" && !Number.isInteger(n)) {
          issues.push({ column: f.key, message: "Expected a whole number of years." });
        } else values[f.key] = n;
      } else if (f.type === "boolean") {
        const low = v.toLowerCase();
        if (TRUTHY.has(low)) values[f.key] = true;
        else if (FALSY.has(low)) values[f.key] = false;
        else issues.push({ column: f.key, message: `Use yes or no (got "${v}").` });
      } else if (f.key === "vendor_name") {
        const id = ctx.vendorsByName.get(v.toLowerCase());
        if (!id) issues.push({ column: f.key, message: `No vendor named "${v}" on record.` });
        else values.assigned_vendor_id = id;
      } else if (f.key === "custodian_email") {
        const id = ctx.usersByEmail.get(v.toLowerCase());
        if (!id) issues.push({ column: f.key, message: `No user with email "${v}" in your organisation.` });
        else values.custodian_user_id = id;
      } else {
        values[f.key] = v;
      }
    }

    // ── Admin-defined custom fields ────────────────────────────────────────
    for (const key of ctx.customFieldKeys) {
      const v = raw[key];
      if (v) custom[key] = v;
    }
    if (Object.keys(custom).length > 0) values.custom_fields = custom;

    // ── Cross-field sanity ─────────────────────────────────────────────────
    const pd = raw["purchase_date"], cd = raw["commissioned_date"];
    if (pd && cd && DATE_RE.test(pd) && DATE_RE.test(cd) && cd < pd) {
      issues.push({
        column: "commissioned_date",
        message: "Commissioned before it was purchased.",
      });
    }

    return {
      rowNumber: line, // the line in the user's file, not our filtered index
      raw,
      values,
      issues,
      valid: issues.length === 0,
    };
  });

  return { rows, headerIssues };
}
