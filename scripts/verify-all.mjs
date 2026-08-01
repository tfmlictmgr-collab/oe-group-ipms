// Every verification suite, with the runner that actually works.
//
// ⚠️ Why this exists. Three suites (`verify-asset-import`,
// `verify-asset-import-e2e`, `verify-reconciliation`) import `.ts` modules whose
// own imports carry no file extension, so bare `node` cannot resolve them and
// they die with ERR_MODULE_NOT_FOUND. Their headers say `npx tsx`. Nothing at
// the point of use said so, so running the set with `node` reported three
// suites as broken when they were fine — and a false failure teaches people to
// discount failures.
//
// `tsx` runs all fifty, including the plain `.mjs` ones, so there is now one
// command and no way to pick the wrong runner.
//
// Usage:
//   npm run verify              — everything
//   npm run verify -- rent      — only suites whose name contains "rent"
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";

// Suites that talk to the pooled Postgres connection are slow (minutes, not
// seconds) because they impersonate every role against every table. Named so
// the runner can give them room rather than appearing to hang.
const SLOW = new Set(["verify-access-matrix", "verify-bi-scoping"]);

const suites = readdirSync(here)
  .filter((f) => f.startsWith("verify-") && f.endsWith(".mjs") && f !== "verify-all.mjs")
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.error(`No suite matches "${filter}".`);
  process.exit(1);
}

console.log(`Running ${suites.length} suite(s) with tsx\n`);

const run = (file) =>
  new Promise((resolve) => {
    const name = file.replace(/\.mjs$/, "");
    const started = Date.now();
    // Node itself, with tsx as a loader — not the `tsx` shim through a shell.
    //
    // `shell: true` earns Node's DEP0190 warning (arguments concatenated rather
    // than escaped, so a path with a space in it breaks), and spawning the
    // `.cmd` shim WITHOUT a shell is EINVAL on Windows. `--import tsx` sidesteps
    // both: one real executable, arguments passed as an array, identical on
    // every platform.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(here, file)],
      { env: process.env }
    );

    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    // A suite that never finishes is a failure, not a reason to wait forever.
    const budget = SLOW.has(name) ? 900_000 : 300_000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ name, ok: false, why: `timed out after ${budget / 1000}s`, secs: budget / 1000 });
    }, budget);

    child.on("close", (code) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      // A missing precondition is not a code failure, and reporting it as one
      // sends whoever sees it hunting through a policy that is working. Some
      // suites drive the running app over HTTP; say so plainly.
      const needsServer = /Cannot reach https?:\/\/[^\s]+/.exec(out);

      // A script that asserts nothing is not coverage, and a green PASS beside
      // it says otherwise. Marked so the count of real suites stays honest.
      const demoOnly = /DEMONSTRATION ONLY/.test(out);

      const summary = needsServer
        ? `needs the dev server — run \`npm run dev\`, then retry`
        : demoOnly
          ? "demonstration only — asserts nothing"
          : out.match(/ALL CHECKS PASSED[^\n]*/)?.[0] ??
            out.match(/\d+ (?:CHECK\(S\) )?FAIL(?:URE\(S\))?[^\n]*/i)?.[0] ??
            out.match(/Error[^\n]*/)?.[0] ??
            "(no summary line — the suite printed nothing recognisable)";
      resolve({
        name,
        ok: code === 0,
        // Distinct from a failure: the suite never got to run its assertions.
        // Counted and listed separately at the end so it stays visible — a
        // silently skipped suite is one that never runs again.
        skipped: Boolean(needsServer),
        demoOnly,
        why: summary.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 96),
        secs,
      });
    });
  });

const results = [];
for (const file of suites) {
  const r = await run(file);
  results.push(r);
  const mark = r.skipped
    ? "\x1b[33mSKIP\x1b[0m"
    : r.demoOnly
      ? "\x1b[36mDEMO\x1b[0m"
      : r.ok
        ? "\x1b[32mPASS\x1b[0m"
        : "\x1b[31mFAIL\x1b[0m";
  console.log(`${mark} ${r.name.padEnd(34)} ${String(r.secs).padStart(4)}s  ${r.why}`);
}

const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.ok && !r.skipped);

if (skipped.length > 0) {
  console.log(
    `\n\x1b[33m${skipped.length} suite(s) could not run:\x1b[0m\n` +
    skipped.map((r) => `  ${r.name} — ${r.why}`).join("\n")
  );
}

console.log(
  failed.length === 0
    ? `\n\x1b[32m${results.length - skipped.length} of ${results.length} suite(s) passed` +
      `${skipped.length ? `, ${skipped.length} skipped` : ""}.\x1b[0m`
    : `\n\x1b[31m${failed.length} of ${results.length} suite(s) FAILED:\x1b[0m\n` +
      failed.map((r) => `  ${r.name} — ${r.why}`).join("\n")
);

// A skip is not a pass, but it is not a failure either — it exits non-zero so
// nothing green-lights on a suite that never executed.
process.exit(failed.length === 0 && skipped.length === 0 ? 0 : 1);
