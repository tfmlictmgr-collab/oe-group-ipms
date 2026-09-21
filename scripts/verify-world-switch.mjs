// `use-env.mjs` refuses every backing file it cannot vouch for.
//
// ⚠️ This suite runs the real script, in a throwaway directory, against
// fixture backing files. It never touches this checkout's own `.env.*` files
// and never reaches a Supabase project — `use-env.mjs` only ever copies one
// local file to another, so proving its refusals needs no credentials and is
// safe on any world, including none.
//
// It exists because of Stage 3.3 on 21 Sept 2026. `.env.prod.local` existed
// but held nothing the script could parse, and every guard in the file is
// written `if (ref && …)` — so a null `ref` made each one evaluate false, the
// file was copied anyway, and the full red PRODUCTION banner printed over
// `project : (unreadable)`. Nothing downstream was harmed, but only because
// an empty `.env.local` cannot reach a database — the guards did not stop it,
// the absence of a hostname did.
//
// Usage: node scripts/verify-world-switch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(rootDir, "scripts", "use-env.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// The recorded production ref, read from the script rather than retyped — a
// hard-coded copy here would keep passing after a rotation while testing
// nothing, which is the failure mode this whole file is about.
const PROD_REF = src.match(/\n\s*prod:\s*"([a-z0-9]{20})"/)?.[1];
const OTHER_REF = "zzzzzzzzzzzzzzzzzzzz"; // 20 chars, the Supabase shape, not ours

const url = (ref) => `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co\nSUPABASE_DB_HOST=db.${ref}.supabase.co\n`;

/** Run use-env.mjs in a scratch directory laid out by `files`. */
function run(files, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "use-env-"));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    let code = 0, out = "";
    try {
      out = execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status ?? 1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const local = fs.existsSync(path.join(dir, ".env.local"))
      ? fs.readFileSync(path.join(dir, ".env.local"), "utf8")
      : null;
    return { code, out, local };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("use-env.mjs — it refuses every backing file it cannot vouch for\n");

// ── Prove the premise before trusting anything below ────────────────────────
console.log("A. The fixture is honest");
PROD_REF
  ? ok(`read the recorded prod ref out of use-env.mjs (${PROD_REF})`)
  : bad("could not read the prod ref from use-env.mjs — every check below is testing a guess");
PROD_REF !== OTHER_REF
  ? ok("the mismatch fixture names a DIFFERENT project than the recorded one")
  : bad("the mismatch fixture equals the recorded ref — the mismatch guard would never fire");

// ── The regression this suite was written for ───────────────────────────────
console.log("\nB. An unreadable backing file is refused, for every world");
for (const world of ["demo", "dev", "staging", "prod"]) {
  for (const [shape, body] of [["an empty", ""], ["a URL-less", "SUPABASE_DB_PASSWORD=hunter2\n"]]) {
    const r = run({ [`.env.${world}.local`]: body }, [world]);
    r.code !== 0 && r.local === null
      ? ok(`${world}: ${shape} backing file is refused, and .env.local is not written`)
      : bad(`${world}: ${shape} backing file exited ${r.code} and ${r.local === null ? "wrote nothing" : "WROTE .env.local"}`);
  }
}

// The specific shape of the 21 Sept failure: refusal must come INSTEAD of the
// production banner, not after it.
{
  const r = run({ ".env.prod.local": "" }, ["prod"]);
  !/NOW POINTS AT PRODUCTION/.test(r.out)
    ? ok("prod: the red PRODUCTION banner is not printed over an unreadable file")
    : bad("prod: the PRODUCTION banner printed for a file naming no project — the 21 Sept regression is back");
}

// ── The guards that already existed, now proven rather than assumed ─────────
console.log("\nC. The guards that were already there");
{
  const r = run({ ".env.prod.local": url(OTHER_REF) }, ["prod"]);
  r.code !== 0 && r.local === null && /recorded in HOSTS/.test(r.out)
    ? ok("a backing file naming a project other than the recorded one is refused")
    : bad(`a mismatched backing file was not refused on its recorded ref (exit ${r.code})`);
}
{
  const r = run({ ".env.prod.local": url(PROD_REF), ".env.staging.local": url(PROD_REF) }, ["prod"]);
  r.code !== 0 && r.local === null && /SAME Supabase project/.test(r.out)
    ? ok("two worlds naming the same project is refused (rule 8)")
    : bad(`two worlds sharing a project was not refused (exit ${r.code})`);
}
{
  const r = run({}, ["prod"]);
  r.code !== 0 && /Missing \.env\.prod\.local/.test(r.out)
    ? ok("a missing backing file is refused, and says to build it from the dashboard")
    : bad(`a missing backing file was not refused (exit ${r.code})`);
}

// ── The happy path still works, or the guards are just breakage ─────────────
console.log("\nD. A correct file still switches");
{
  const r = run({ ".env.prod.local": url(PROD_REF) }, ["prod"]);
  r.code === 0 && r.local === url(PROD_REF)
    ? ok("prod: a correct backing file is copied to .env.local verbatim")
    : bad(`prod: a correct backing file did not switch (exit ${r.code})`);
  /NOW POINTS AT PRODUCTION/.test(r.out) && /NO legitimate use here/i.test(r.out)
    ? ok("prod: the banner and the seed warning both print on a real switch")
    : bad("prod: switching to production printed no banner — the loudest case went quiet");
}
{
  const r = run({ ".env.dev.local": url(OTHER_REF) }, ["dev"]);
  // dev's recorded ref is not OTHER_REF, so this must be refused too — the
  // recorded-ref guard is not production-only.
  r.code !== 0 && /recorded in HOSTS/.test(r.out)
    ? ok("dev: the recorded-ref guard is not production-only")
    : bad(`dev: a mismatched backing file was allowed through (exit ${r.code})`);
}

console.log("");
console.log(failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m — use-env.mjs refuses every file it cannot vouch for." : `\x1b[31m${failures} check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
