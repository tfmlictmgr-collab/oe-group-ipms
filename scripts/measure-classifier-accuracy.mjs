// Week 2 deliverable: measure the triage classifier's agreement rate against the
// held-out labelled sample (docs/sample-requests.json). Runs every sample through
// the SAME classifier the live intake uses (lib/triage.ts → classifyMessage) and
// reports category agreement, priority agreement, and both-correct — overall and
// per category. Writes a timestamped report to docs/classifier-accuracy-report.md.
//
// Usage: npx tsx scripts/measure-classifier-accuracy.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const { classifyMessage } = await import("../lib/triage.ts");

const sample = JSON.parse(
  readFileSync(path.join(rootDir, "docs", "sample-requests.json"), "utf8")
);
const samples = sample.samples;

console.log(`Running ${samples.length} samples through the live classifier…\n`);

const rows = [];
let catHits = 0;
let priHits = 0;
let bothHits = 0;

// One-step-off priority is treated as a "near miss" (reported separately) since
// priority is inherently more subjective than category.
const PRIORITY_ORDER = ["low", "normal", "high", "critical"];
function priorityDistance(a, b) {
  return Math.abs(PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b));
}

for (const s of samples) {
  const result = await classifyMessage(s.text);
  const catOk = result.category === s.expected_category;
  const priOk = result.urgency === s.expected_priority;
  const priNear = priorityDistance(result.urgency, s.expected_priority) <= 1;
  if (catOk) catHits++;
  if (priOk) priHits++;
  if (catOk && priOk) bothHits++;
  rows.push({
    id: s.id,
    text: s.text,
    expCat: s.expected_category,
    gotCat: result.category,
    catOk,
    expPri: s.expected_priority,
    gotPri: result.urgency,
    priOk,
    priNear,
  });
  process.stdout.write(catOk && priOk ? "." : catOk ? "c" : "x");
}
process.stdout.write("\n\n");

const n = samples.length;
const pct = (h) => ((h / n) * 100).toFixed(1);
const priNearHits = rows.filter((r) => r.priNear).length;

// Per-category category-agreement
const cats = [...new Set(samples.map((s) => s.expected_category))];
const perCat = cats.map((c) => {
  const rs = rows.filter((r) => r.expCat === c);
  const hits = rs.filter((r) => r.catOk).length;
  return { c, hits, total: rs.length };
});

console.log("=== CLASSIFIER AGREEMENT (vs held-out sample) ===");
console.log(`  Category agreement:        ${catHits}/${n}  (${pct(catHits)}%)`);
console.log(`  Priority agreement:        ${priHits}/${n}  (${pct(priHits)}%)`);
console.log(`  Priority within one step:  ${priNearHits}/${n}  (${pct(priNearHits)}%)`);
console.log(`  Both correct:              ${bothHits}/${n}  (${pct(bothHits)}%)`);
console.log("\n  Per-category (category agreement):");
for (const p of perCat) {
  console.log(`    ${p.c.padEnd(12)} ${p.hits}/${p.total}`);
}

const misses = rows.filter((r) => !r.catOk || !r.priOk);
if (misses.length) {
  console.log("\n  Disagreements:");
  for (const m of misses) {
    const parts = [];
    if (!m.catOk) parts.push(`cat ${m.expCat}→${m.gotCat}`);
    if (!m.priOk) parts.push(`pri ${m.expPri}→${m.gotPri}${m.priNear ? " (near)" : ""}`);
    console.log(`    ${m.id}  ${parts.join(", ")}`);
  }
}

// Markdown report
const now = new Date().toISOString();
const md = `# Classifier Accuracy Report

**Generated:** ${now}
**Sample:** \`docs/sample-requests.json\` (${n} synthetic, hand-labelled requests)
**Classifier:** \`lib/triage.ts\` → \`classifyMessage\` (Claude \`claude-sonnet-4-6\`, live intake path)

## Agreement rate

| Metric | Result |
|---|---|
| Category agreement | ${catHits}/${n} (${pct(catHits)}%) |
| Priority agreement | ${priHits}/${n} (${pct(priHits)}%) |
| Priority within one step | ${priNearHits}/${n} (${pct(priNearHits)}%) |
| Both category + priority correct | ${bothHits}/${n} (${pct(bothHits)}%) |

### Per-category (category agreement)

| Category | Agreement |
|---|---|
${perCat.map((p) => `| ${p.c} | ${p.hits}/${p.total} |`).join("\n")}

## Disagreements

${
  misses.length === 0
    ? "None."
    : misses
        .map((m) => {
          const parts = [];
          if (!m.catOk) parts.push(`category \`${m.expCat}\`→\`${m.gotCat}\``);
          if (!m.priOk)
            parts.push(`priority \`${m.expPri}\`→\`${m.gotPri}\`${m.priNear ? " (one step)" : ""}`);
          return `- **${m.id}** — ${parts.join(", ")}  \n  _"${m.text}"_`;
        })
        .join("\n")
}

## Notes

- Priority is inherently more subjective than category; "within one step" is
  reported because a low↔normal or high↔critical difference is often a defensible
  judgement call rather than an error.
- Sample is **synthetic** (no real client data at POC time). Re-run against a real
  anonymised sample when available; the harness is unchanged.
`;

writeFileSync(path.join(rootDir, "docs", "classifier-accuracy-report.md"), md);
console.log("\nReport written to docs/classifier-accuracy-report.md");
