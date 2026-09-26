// Every public page answers only on its own organisation's host (B1).
//
// Found 26 Sept 2026 in the security self-assessment (Part A): OEA's vendor
// application page, `/apply/<OEA's id>`, opened on `www.tfmlportal.com` when
// the host in its link was swapped. OEA's name and form appeared under TFML's
// address, which B1 forbids: a portal must never show the other brand's data
// OR EXISTENCE. The public pages took their organisation from the URL and never
// asked whose the host was. `/o/[slug]` already did; nothing made the others.
//
// This suite is the something:
//   A. the rule itself, exercised (lib/host-org-rule.ts);
//   B. EVERY public page with a dynamic segment asks it — discovered from the
//      filesystem, so a public page added tomorrow fails here until it does;
//   C. the two submissions whose organisation comes from the request also ask.
//
// No database, no network, no credentials.
//
// Usage: npx tsx scripts/verify-public-pages-host-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostAllowsOrg } from "../lib/host-org-rule.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Comments stripped, so an explanatory comment naming the helper cannot pass
// a check the code itself fails.
const code = (file) =>
  fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

console.log("Every public page answers only on its own organisation's host (B1)");

section("A. The rule");
{
  const TFML = "11111111-1111-1111-1111-111111111111";
  const OEA = "22222222-2222-2222-2222-222222222222";
  const cases = [
    [null, OEA, true, "an unbound host (localhost, previews, the deployment address) shows any org"],
    [OEA, OEA, true, "an org's own host shows its page"],
    [TFML, OEA, false, "TFML's host refuses OEA's page — the finding"],
    [OEA, TFML, false, "OEA's host refuses TFML's page"],
    [TFML, null, false, "a bound host refuses a page whose org could not be established"],
    [TFML, undefined, false, "…and an undefined one"],
    [TFML, "", false, "…and an empty one"],
  ];
  for (const [host, org, want, label] of cases) {
    hostAllowsOrg(host, org) === want ? ok(label) : bad(`${label}: got ${!want}`);
  }
}

section("B. Every public page with a dynamic segment asks it");
{
  // Public = outside the signed-in app and the API. Discovered, not listed.
  const pages = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "page.tsx") pages.push(path.relative(rootDir, p));
    }
  };
  walk(path.join(rootDir, "app"));
  const isPublicDynamic = (p) =>
    p.includes("[") && !/^app\/(dashboard|orgs|api)\//.test(p.split(path.sep).join("/"));

  // Pages that show NO organisation's name or brand, so there is nothing for a
  // host to leak. Each needs its reason; a new entry here is a decision.
  const EXEMPT = {
    "app/apply/confirm/[token]/page.tsx":
      "confirms an email address; renders only 'Email confirmed' or 'This link isn't valid', no org",
  };

  const found = pages.map((p) => p.split(path.sep).join("/")).filter(isPublicDynamic).sort();
  if (found.length < 7) bad(`only ${found.length} public dynamic pages found — the walk is broken`);
  for (const p of found) {
    if (EXEMPT[p]) { ok(`${p} — exempt: ${EXEMPT[p]}`); continue; }
    const src = code(path.join(rootDir, p));
    const guarded =
      /hostServesOrg\(/.test(src) ||
      // /o/[slug] predates the helper and compares slugs directly.
      (/orgForCurrentHost\(/.test(src) && /notFound\(\)/.test(src));
    guarded ? ok(`${p} asks whose host this is`) : bad(`${p} renders an org chosen by the URL without asking whose host it is`);
  }
}

section("C. Submissions whose organisation comes from the request");
{
  for (const [file, fn] of [
    ["app/apply/[orgId]/actions.ts", "submitVendorApplication"],
    ["app/tenancy/[org]/actions.ts", "startApplication"],
  ]) {
    const src = code(path.join(rootDir, file));
    const start = src.indexOf(`export async function ${fn}`);
    const body = start >= 0 ? src.slice(start, start + 600) : "";
    /hostServesOrg\(/.test(body)
      ? ok(`${fn} refuses another org's host before doing anything`)
      : bad(`${fn} does not ask hostServesOrg at its start (${file})`);
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32mALL CHECKS PASSED\x1b[0m — no public page answers on another organisation's host.`
    : `\n\x1b[31m${failures} FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
