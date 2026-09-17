// Exercises the bulk-import validator with a deliberately messy file: valid
// rows, a duplicate tag, an in-file duplicate, a typo'd category, an unmanaged
// property, a bad date, a bad number, a mismatched unit and an unknown vendor.
// Pure logic — no DB — so it runs fast and pins the rules down exactly.
// Usage: npx tsx scripts/verify-asset-import.mjs
import { validateAssetCsv } from "../lib/asset-import.ts";
import { buildTemplateCsv, parseCsv, ASSET_FIELDS } from "../lib/asset-schema.ts";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const ctx = {
  propertiesByName: new Map([["ikoyi court", "prop-ikoyi"], ["lekki plaza", "prop-lekki"]]),
  unitsByKey: new Map([["prop-ikoyi::shop 1", "unit-1"]]),
  vendorsByName: new Map([["powergen services ltd", "vend-1"]]),
  usersByEmail: new Map([["oe-group-foundation-poc.facilitymanager@oegroup.test", "user-fm"]]),
  existingTags: new Set(["gen-ikj-001"]),
  customFieldKeys: ["refrigerant_type"],
};

console.log("Asset bulk-import validation\n");

console.log("A. The generated template is self-consistent");
{
  const csv = buildTemplateCsv(ctx.customFieldKeys);
  const grid = parseCsv(csv);
  // parseCsv drops the '#' guidance + example rows, so only the header remains.
  if (grid.length === 1) ok("template guidance/example rows are skipped by the parser");
  else bad(`expected only the header to survive parsing, got ${grid.length} rows`);

  const header = grid[0];
  const missing = ASSET_FIELDS.map((f) => f.key).filter((k) => !header.includes(k));
  if (missing.length === 0) ok(`header carries all ${ASSET_FIELDS.length} fields + custom`);
  else bad(`template header missing: ${missing.join(", ")}`);

  if (header.includes("refrigerant_type")) ok("custom field appears as a column");
  else bad("custom field missing from template");
}

console.log("\nB. A messy file is validated row by row");
const csv = [
  "asset_tag,name,category,property_name,unit_label,criticality,purchase_cost,purchase_date,commissioned_date,vendor_name,custodian_email,compliance_required,certificate_expiry,refrigerant_type",
  // 2 valid
  "GEN-IKJ-011,Cummins 150kVA,power_generation,Ikoyi Court,,critical,\"18,500,000\",2023-04-12,2023-05-02,PowerGen Services Ltd,oe-group-foundation-poc.facilitymanager@oegroup.test,yes,2026-08-12,R410A",
  // 3 valid with unit
  "HVA-IKJ-012,Split AC Reception,hvac,Ikoyi Court,Shop 1,medium,450000,,,,,no,,",
  // 4 duplicate of an existing tag
  "GEN-IKJ-001,Perkins 250kVA,power_generation,Ikoyi Court,,critical,,,,,,,,",
  // 5 typo'd category
  "SEC-IKJ-013,CCTV NVR,securty,Ikoyi Court,,high,,,,,,,,",
  // 6 property the caller does not manage
  "PMP-VIC-002,Sump Pump,plumbing,Victoria Court,,low,,,,,,,,",
  // 7 unit that belongs to a different property
  "FIR-LEK-014,Extinguisher,fire_safety,Lekki Plaza,Shop 1,high,,,,,,,,",
  // 8 bad date + bad number + unknown vendor
  "ELE-IKJ-015,Distribution Board,electrical,Ikoyi Court,,medium,abc,12/04/2023,,Nonexistent Ltd,,,,",
  // 9 in-file duplicate of row 2
  "GEN-IKJ-011,Duplicate In File,power_generation,Ikoyi Court,,low,,,,,,,,",
  // 10 commissioned before purchase
  "PMP-IKJ-016,Booster Pump,plumbing,Ikoyi Court,,medium,,2024-06-01,2024-01-01,,,,,",
  // 11 missing required name
  ",,hvac,Ikoyi Court,,low,,,,,,,,",
].join("\n");

const { rows, headerIssues } = validateAssetCsv(csv, ctx);
console.log(`  (parsed ${rows.length} data rows; header notes: ${headerIssues.length})`);

const byNum = Object.fromEntries(rows.map((r) => [r.rowNumber, r]));
const expectValid = (n) =>
  byNum[n]?.valid ? ok(`row ${n} valid`) : bad(`row ${n} should be valid — ${JSON.stringify(byNum[n]?.issues)}`);
const expectIssue = (n, col, needle) => {
  const r = byNum[n];
  const hit = r?.issues.find((i) => i.column === col && i.message.toLowerCase().includes(needle.toLowerCase()));
  if (hit) ok(`row ${n} → ${col}: ${hit.message}`);
  else bad(`row ${n} expected a "${needle}" issue on ${col}; got ${JSON.stringify(r?.issues)}`);
};

expectValid(2);
expectValid(3);
expectIssue(4, "asset_tag", "already exists");
expectIssue(5, "category", "did you mean");
expectIssue(6, "property_name", "do not manage");
expectIssue(7, "unit_label", "no unit");
expectIssue(8, "purchase_date", "YYYY-MM-DD");
expectIssue(8, "purchase_cost", "positive number");
expectIssue(8, "vendor_name", "no vendor");
expectIssue(9, "asset_tag", "more than once");
expectIssue(10, "commissioned_date", "before it was purchased");
expectIssue(11, "asset_tag", "required");
expectIssue(11, "name", "required");

console.log("\nC. Valid rows are converted to insertable values");
{
  const r = byNum[2];
  const v = r.values;
  const checks = [
    [v.property_id === "prop-ikoyi", "property resolved to an id"],
    [v.purchase_cost === 18500000, "\"18,500,000\" parsed to 18500000"],
    [v.assigned_vendor_id === "vend-1", "vendor resolved to an id"],
    [v.custodian_user_id === "user-fm", "custodian email resolved to a user id"],
    [v.compliance_required === true, "\"yes\" parsed to boolean true"],
    [v.category === "power_generation", "category kept as the enum value"],
    [v.custom_fields?.refrigerant_type === "R410A", "custom field captured into custom_fields"],
    [!("property_name" in v), "property_name not passed through as a column"],
  ];
  for (const [pass, label] of checks) pass ? ok(label) : bad(label);
}

console.log("\nD. A row with any issue is never marked valid");
{
  const wrong = rows.filter((r) => r.valid && r.issues.length > 0);
  if (wrong.length === 0) ok("no row is both valid and issued");
  else bad(`${wrong.length} row(s) marked valid despite issues`);
  const counts = { valid: rows.filter((r) => r.valid).length, invalid: rows.filter((r) => !r.valid).length };
  console.log(`  (summary: ${counts.valid} valid, ${counts.invalid} blocked)`);
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the importer catches every seeded defect."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
