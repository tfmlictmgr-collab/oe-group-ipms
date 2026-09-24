// The public legal pages name the organisation that owns the domain being
// visited — and no other (B1).
//
// B1: "a user on one portal must never see the other brand's data OR
// EXISTENCE". Terms and Refunds were built to it from the start — legal-org.ts
// resolves the org from the HOST and "no other organisation is named". The
// privacy notice's first published version (24 Sept 2026) broke it: its §1
// listed both client brands by name, so every OEA tenant was told TFML exists
// and every TFML tenant was told OEA does — on the page every applicant is
// linked to from the consent step. It was caught by reading the page, not by
// anything failing. This suite is the something.
//
// Static and self-contained: no database, no network, no credentials.
//
// Usage: node scripts/verify-legal-single-brand.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/**
 * Source with block and whole-line comments removed — the same rule
 * verify-bootstrap uses. Without it this suite would FAIL on the explanatory
 * comment in the privacy page that names the brands to describe the defect,
 * exactly as a check once PASSED on a comment in bootstrap-production.mjs.
 */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

// A brand named as a literal. `\b` keeps "TFML" out of identifiers like
// "tfmlportal" only when case differs — so match case-sensitively on the
// abbreviations and case-insensitively on the full names.
const BRAND = [
  /Total\s+Facilities\s+Management/i,
  /Ora\s+Egbunike/i,
  /\bTFML\b/,
  /\bOEA\b/,
];
const brandsIn = (code) => BRAND.filter((re) => re.test(code)).map((re) => re.source);

const legalDir = path.join(rootDir, "app", "legal");
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) pages.push(p);
  }
})(legalDir);

// ════════════════════════════════════════════════════════════════════════════
section("A. The check can fail — it flags the text the notice was first published with");
{
  // The §1 paragraph as published in a089857. If the matcher cannot see the
  // defect it exists for, every pass below means nothing.
  const firstPublished =
    "This notice covers the integrated facilities and property management platform operated by " +
    "OE Group through its two brands: <strong>TFML — Total Facilities Management Limited</strong>, " +
    "a facilities management company, and <strong>OEA — Ora Egbunike &amp; Associates</strong>";
  const hits = brandsIn(firstPublished);
  hits.length === BRAND.length
    ? ok(`the original §1 is flagged on all ${BRAND.length} patterns`)
    : bad(`the original §1 is flagged on only ${hits.length} of ${BRAND.length} patterns — the matcher is too weak`);

  const commentOnly = "{/* an OEA tenant was told TFML exists */}\n// Total Facilities Management\n";
  brandsIn(codeOnly(commentOnly)).length === 0
    ? ok("…and a brand named only in a comment is NOT flagged")
    : bad("a comment tripped the check — codeOnly is not stripping it");
}

// ════════════════════════════════════════════════════════════════════════════
section("B. Every legal page names no brand of its own accord");
{
  pages.length >= 4
    ? ok(`${pages.length} files under app/legal`)
    : bad(`only ${pages.length} files under app/legal — expected layout, org resolver, terms, refunds, privacy`);
  for (const p of pages) {
    const rel = path.relative(rootDir, p);
    const hits = brandsIn(codeOnly(fs.readFileSync(p, "utf8")));
    hits.length === 0
      ? ok(`${rel} names no brand`)
      : bad(`${rel} names a brand outright (${hits.join(", ")}) — on every other brand's portal that is B1 broken`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("C. Every page takes its organisation from the host");
{
  for (const p of pages.filter((f) => /page\.tsx$/.test(f))) {
    const rel = path.relative(rootDir, p);
    const code = codeOnly(fs.readFileSync(p, "utf8"));
    if (/\bredirect\(/.test(code) && !/legalOrgForHost/.test(code)) {
      ok(`${rel} only redirects`);
      continue;
    }
    /legalOrgForHost\(\)/.test(code)
      ? ok(`${rel} resolves its organisation from the host`)
      : bad(`${rel} does not call legalOrgForHost() — it cannot know whose portal it is on`);
  }
}

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
    : "\n\x1b[32mALL CHECKS PASSED\x1b[0m — each legal page names the organisation whose domain it is on, and no other."
);
process.exit(failures ? 1 : 0);
