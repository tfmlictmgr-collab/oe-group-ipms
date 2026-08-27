// Builds a training deck for one organisation, straight from the same
// catalogue the /dashboard/training screen and the PDF route both read
// (`lib/guides/processes.ts`) — the fourth surface on the same one source,
// never a hand-built deck that goes stale the day a process changes.
//
// Trainer notes (the demo, the common mistake, the practice exercise) go into
// each slide's SPEAKER NOTES rather than onto the slide itself — a projected
// slide is what the room reads, and a slide crowded with presenter-only
// prompts is worse for both audiences than a clean one with good notes
// underneath. The Team edition (`--team`) renders the same visible slides
// with no notes at all, for handing to someone presenting without a trainer.
//
// ⚠️ Run with plain `node`, NOT `tsx` — verified against both. `pptxgenjs` is
// CommonJS; node's own interop unwraps its default export correctly, but
// tsx's ESM loader does not (`pptxgen is not a constructor`), and the same is
// true of the pre-existing `build-demo-readiness-deck.mjs`. Node 24 strips
// this file's own `.ts` imports natively, so no loader is needed either way.
//
// Usage:
//   node scripts/build-training-deck.mjs <org-slug>
//   node scripts/build-training-deck.mjs <org-slug> --team
//   node scripts/build-training-deck.mjs <org-slug> --role facility_manager
//   node scripts/build-training-deck.mjs <org-slug> --out ./scratchpad/x.pptx
//
// Output lands in docs/generated/ by default — gitignored, because a
// generated deck carries this org's own thresholds and branding, and a
// generated artifact is not the source `processes.ts` is.
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import pptxgen from "pptxgenjs";
import {
  processesForEdition, processesForRole,
} from "../lib/guides/processes.ts";
import { roleLabel } from "../lib/roles.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const argv = process.argv.slice(2);
const slug = argv[0];
if (!slug || slug.startsWith("--")) {
  console.error("\nUsage: node scripts/build-training-deck.mjs <org-slug> [--team] [--role <key>] [--out <path>]\n");
  process.exit(1);
}
const trainerView = !argv.includes("--team");
const roleFlagIdx = argv.indexOf("--role");
const roleFilter = roleFlagIdx === -1 ? null : argv[roleFlagIdx + 1];
const outFlagIdx = argv.indexOf("--out");
const outOverride = outFlagIdx === -1 ? null : argv[outFlagIdx + 1];

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: org, error: orgErr } = await svc
  .from("orgs")
  .select("id, name, slug, delivery_brand, is_platform_operator, theme_primary, logo_url, tagline")
  .eq("slug", slug)
  .is("deleted_at", null)
  .maybeSingle();
if (orgErr) { console.error(`\n${orgErr.message}\n`); process.exit(1); }
if (!org) { console.error(`\nNo live organisation with slug "${slug}".\n`); process.exit(1); }

const { data: moduleRows } = await svc
  .from("org_modules").select("module").eq("org_id", org.id).eq("enabled", true);
const orgFeatures = new Set((moduleRows ?? []).map((r) => r.module));

const edition = org.is_platform_operator ? "operator" : org.delivery_brand === "OEA" ? "OEA" : "TFML";
const all = roleFilter
  ? processesForRole(roleFilter, edition, orgFeatures)
  : processesForEdition(edition, orgFeatures);

if (all.length === 0) {
  console.error(`\nNothing to render — no processes for ${roleFilter ? `role "${roleFilter}"` : "this edition"}.\n`);
  process.exit(1);
}

// Group by module, preserving catalogue order.
const groups = [];
for (const p of all) {
  const last = groups[groups.length - 1];
  if (last && last.module === p.module) last.items.push(p);
  else groups.push({ module: p.module, items: [p] });
}

const NAVY = org.theme_primary || "1E2761";
const INK = "16233F";
const MUTED = "5B6B8C";
const GOOD = "1B7F5A";
const WARN = "B4690E";
const WHITE = "FFFFFF";
const H = "Cambria";
const B = "Calibri";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = org.name;
pres.company = org.name;
pres.title = `${org.name} — Training`;

const label = (role) => (role === "system" ? "Automatic" : roleLabel(role, org.delivery_brand));

function titleSlide() {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  if (org.logo_url) {
    try { s.addImage({ path: org.logo_url, x: 0.7, y: 0.55, w: 0.9, h: 0.9 }); } catch { /* remote logo not fetchable at build time — omit rather than fail the deck */ }
  }
  s.addText(org.is_platform_operator ? "Operator Training" : `${org.name} — Training`, {
    x: 0.7, y: 1.7, w: 11.9, h: 1.1, margin: 0,
    fontFace: H, fontSize: 40, bold: true, color: WHITE,
  });
  s.addText(
    roleFilter
      ? `${label(roleFilter)} — every process this role appears in`
      : "Every process in this organisation, by module.",
    { x: 0.7, y: 2.75, w: 10.5, h: 0.6, margin: 0, fontFace: B, fontSize: 15, color: "CADCFC" }
  );
  s.addText(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), {
    x: 0.7, y: 6.7, w: 6, h: 0.35, margin: 0, fontFace: B, fontSize: 11, color: "CADCFC",
  });
}

function agendaSlide() {
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText("Agenda", { x: 0.7, y: 0.5, w: 11.9, h: 0.6, margin: 0, fontFace: H, fontSize: 30, bold: true, color: NAVY });
  const lines = groups.map((g) => ({
    text: `${g.module}  `, options: { bold: true, color: NAVY, breakLine: false },
  })).flatMap((t, i) => [t, { text: `(${groups[i].items.length})`, options: { color: MUTED, breakLine: true } }]);
  s.addText(lines, {
    x: 0.7, y: 1.4, w: 11.9, h: 5.5, margin: 0, fontFace: B, fontSize: 16,
    lineSpacingMultiple: 1.6, bullet: { code: "2022" },
  });
}

function moduleDivider(module) {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  s.addText(module, { x: 0.7, y: 3.1, w: 11.9, h: 1.2, margin: 0, fontFace: H, fontSize: 36, bold: true, color: WHITE });
}

function processSlide(p) {
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText(p.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.65, margin: 0, fontFace: H, fontSize: 24, bold: true, color: NAVY });
  s.addText(`Starts when: ${p.startsWhen}`, {
    x: 0.6, y: 0.95, w: 12.1, h: 0.5, margin: 0, fontFace: B, fontSize: 11.5, italic: true, color: MUTED,
  });

  const stepLines = p.steps.flatMap((step) => [
    { text: `${label(step.role).toUpperCase()}  ·  `, options: { bold: true, color: NAVY, breakLine: false, fontSize: 12.5 } },
    { text: step.action, options: { color: INK, breakLine: true, fontSize: 12.5 } },
  ]);
  s.addText(stepLines, {
    x: 0.6, y: 1.55, w: 7.5, h: 4.8, margin: 0, fontFace: B, lineSpacingMultiple: 1.35,
    bullet: { code: "25B8" }, valign: "top",
  });

  s.addShape(pres.ShapeType.roundRect, {
    x: 8.35, y: 1.55, w: 4.15, h: 1.7, rectRadius: 0.08,
    fill: { color: "EEF7F1" }, line: { color: GOOD, width: 1 },
  });
  s.addText("DONE MEANS", { x: 8.55, y: 1.68, w: 3.8, h: 0.3, margin: 0, fontFace: B, fontSize: 10, bold: true, color: GOOD });
  s.addText(p.doneMeans, { x: 8.55, y: 2.0, w: 3.8, h: 1.15, margin: 0, fontFace: B, fontSize: 10.5, color: INK, lineSpacingMultiple: 1.2 });

  if (p.refusals?.length) {
    s.addShape(pres.ShapeType.roundRect, {
      x: 8.35, y: 3.4, w: 4.15, h: 2.9, rectRadius: 0.08,
      fill: { color: "FBF3E8" }, line: { color: WARN, width: 1 },
    });
    s.addText("COMMON REFUSALS", { x: 8.55, y: 3.53, w: 3.8, h: 0.3, margin: 0, fontFace: B, fontSize: 10, bold: true, color: WARN });
    const refLines = p.refusals.slice(0, 2).flatMap((r) => [
      { text: r.trigger, options: { bold: true, color: INK, breakLine: true, fontSize: 9.5 } },
      { text: r.explanation, options: { color: MUTED, breakLine: true, fontSize: 9 } },
    ]);
    s.addText(refLines, { x: 8.55, y: 3.85, w: 3.8, h: 2.35, margin: 0, fontFace: B, lineSpacingMultiple: 1.2 });
  }

  if (trainerView) {
    const notes = [
      `DEMO: ${p.trainer.demo}`,
      p.trainer.commonMistake ? `COMMON MISTAKE: ${p.trainer.commonMistake}` : null,
      `PRACTICE EXERCISE: ${p.trainer.exercise}`,
    ].filter(Boolean).join("\n\n");
    s.addNotes(notes);
  }
}

titleSlide();
agendaSlide();
for (const g of groups) {
  moduleDivider(g.module);
  for (const p of g.items) processSlide(p);
}

const editionTag = roleFilter ? `role-${roleFilter}` : edition.toLowerCase();
const viewTag = trainerView ? "trainer" : "team";
const outPath = outOverride ?? `docs/generated/${org.slug}-${editionTag}-${viewTag}.pptx`;
mkdirSync(path.dirname(path.join(rootDir, outPath)), { recursive: true });
await pres.writeFile({ fileName: outPath });
console.log(`wrote ${outPath}  (${all.length} process${all.length === 1 ? "" : "es"}, ${groups.length} module${groups.length === 1 ? "" : "s"})`);
