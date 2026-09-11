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
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";

// Suites that talk to the pooled Postgres connection are slow (minutes, not
// seconds) because they impersonate every role against every table. Named so
// the runner can give them room rather than appearing to hang.
//
// `verify-finance-journey` joined them on 28 Aug 2026 and is a different shape
// of slow, worth naming: it walks EVERY non-operator organisation, so its
// runtime grows with the client list rather than with the code. Restoring the
// service-charge client (0208) took it from three orgs to four, 150s standalone
// — and past the 300s budget under the load of a full run, where it was killed
// mid-suite and reported as a failure. The next client org added will do the
// same again to whatever budget it has, which is an argument for the generous
// one rather than for trimming the suite.
const SLOW = new Set([
  "verify-access-matrix",
  "verify-bi-scoping",
  "verify-finance-journey",
  // Added 7 Sept 2026, after all three were killed at 300s in a full run and
  // then PASSED standalone. A budget that fails a working suite is worse than
  // no budget: it produces a red that survives investigation only until
  // somebody re-runs the file, which is how a runner teaches people to
  // re-run rather than to read.
  //
  //   conversational-intelligence — calls the router MODEL once per message,
  //     33 checks, ~5 minutes of real API latency that no amount of local
  //     speed changes;
  //   notification-links, role-workflows — both walk every role in every org,
  //     so like `verify-finance-journey` their runtime grows with the client
  //     list rather than with the code.
  "verify-conversational-intelligence",
  "verify-notification-links",
  "verify-role-workflows",
]);

// 📌 `verify-vendor-self-service` is deliberately NOT here, though it was
// killed at 300s on 8 Sept 2026. Naming it would have been the wrong remedy
// and would have hidden the fault: it was not doing 300 seconds of work, it
// was spending ~260 of them re-attempting 137 deletions the schema forbids
// (`audit_log_actor_id_fkey` — the trail is immutable, so a probe account that
// ever acted cannot be erased), on a backlog that only ever grew. Fixed where
// it was broken — the sweep is bulk, skips what is already neutralised, and
// deactivates what cannot be deleted — it now runs in **72 seconds**. A budget
// that fails a working suite is worse than no budget; a budget raised to
// accommodate a suite that is failing at something is worse still.

const suites = readdirSync(here)
  .filter((f) => f.startsWith("verify-") && f.endsWith(".mjs") && f !== "verify-all.mjs")
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.error(`No suite matches "${filter}".`);
  process.exit(1);
}

console.log(`Running ${suites.length} suite(s) with tsx\n`);

// ── The real organisations, as they were before the run ────────────────────
//
// ⚠️ Added 11 Sept 2026. `verify-custom-domains` rebound the REAL TFML and OEA
// organisations to probe hostnames and relied on its own teardown to put
// `oeaportal.com` / `tfmlportal.com` back. A full run killed it at the 300s
// budget, the teardown never ran, and both brands' live front doors served the
// generic OE Group screen until somebody noticed the colour was wrong. That
// suite now owns its organisations — but twenty suites write to `orgs`, and
// the runner is the ONE process that survives a suite being killed. So it
// snapshots every real organisation before the run and compares after each
// suite:
//
//   • drift after a suite that FINISHED is reported as that suite's failure and
//     left alone — its teardown is wrong, and a person should see exactly what
//     it changed rather than have the runner quietly paper over it;
//   • drift after a suite that was KILLED (timeout, crash) is also restored,
//     column by column, because its teardown provably did not run, and every
//     later suite — and the live portal on the same database — would otherwise
//     run against an organisation nobody configured.
//
// `orgs` has no volatile column (no updated_at, no counters), so any
// difference at all is a real change. Probe organisations — named PROBE* by
// every suite that provisions one — are excluded; they exist to be changed.
config({ path: path.join(here, "..", ".env.local"), quiet: true });
const svc =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

async function realOrgs() {
  if (!svc) return null;
  try {
    const { data, error } = await svc.from("orgs").select("*").not("name", "like", "PROBE%");
    if (error || !data) return null;
    return new Map(data.map((o) => [o.id, o]));
  } catch {
    return null; // the network, again — the next suite's check will catch up
  }
}

const baseline = await realOrgs();
if (!baseline) {
  console.log("\x1b[33m(organisation drift guard is OFF — could not read the org register)\x1b[0m\n");
}

function driftSince(before, now) {
  const out = [];
  for (const [id, was] of before) {
    const is = now.get(id);
    if (!is) continue;
    const cols = Object.keys(was).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(is[k]));
    if (cols.length) out.push({ id, slug: was.slug ?? was.name, cols, was });
  }
  return out;
}

// A failure whose only cause is the network — DNS not answering, a connection
// reset, the database's front door timing out — says nothing about the code.
// On 11 Sept three suites failed this way in one run (`getaddrinfo EAI_AGAIN`)
// and passed the moment they were re-run, which is exactly the red that
// teaches people to re-run rather than to read. One retry after a pause; if
// the network is still down, the suite is listed as "could not run", never as
// a failure of the thing it tests.
const NETWORK = /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|fetch failed|getaddrinfo/;

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
      resolve({
        name, ok: false, killed: true, raw: out,
        why: `timed out after ${budget / 1000}s`, secs: budget / 1000,
      });
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
          // ⚠️ Match on the SHAPE of a summary, not on one exact sentence.
          //
          // This looked only for the literal "ALL CHECKS PASSED", and eight
          // suites sign off in their own words — "All ops requisition checks
          // passed.", "All consent checks passed." — so a green run reported
          // them as "(no summary line — the suite printed nothing
          // recognisable)". Reading that beside a PASS teaches you to ignore
          // the summary column, which is the column that tells you whether a
          // suite asserted anything at all. Same argument as the DEMO marker
          // below it.
          // 📌 And strip the colour BEFORE matching, not after. Every one of
          // these lines is printed as `\n\x1b[32mAll … passed.\x1b[0m`, so the
          // `^` in the second pattern anchored to the ESCAPE SEQUENCE and
          // never to `All` — which is why fourteen green suites reported "the
          // suite printed nothing recognisable" while the pattern written to
          // catch them looked correct. A regex against text that still carries
          // its formatting is matching something other than what it reads
          // like.
          : (() => {
              const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
              return (
                plain.match(/ALL \d* ?CHECKS? PASSED[^\n]*/i)?.[0] ??
                plain.match(/^\s*All [^\n]*checks? passed[^\n]*/im)?.[0]?.trim() ??
                plain.match(/\d+ (?:CHECK\(S\) )?FAIL(?:URE\(S\)|ED)?[^\n]*/i)?.[0] ??
                plain.match(/\d+ check\(s\) failed[^\n]*/i)?.[0] ??
                plain.match(/Error[^\n]*/)?.[0] ??
                "(no summary line — the suite printed nothing recognisable)"
              );
            })();
      resolve({
        name,
        ok: code === 0,
        // Killed by a signal rather than exiting: its teardown did not run.
        killed: code === null,
        raw: out,
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
  let r = await run(file);
  if (!r.ok && !r.skipped && NETWORK.test(r.raw ?? "")) {
    await new Promise((res) => setTimeout(res, 5000));
    const again = await run(file);
    r = again.ok || !NETWORK.test(again.raw ?? "")
      ? { ...again, why: `${again.why} (retried once: the network failed the first attempt)` }
      : { ...again, network: true, why: `network unavailable — ${String(again.why).slice(0, 60)}` };
  }

  if (baseline) {
    const now = await realOrgs();
    const drift = now ? driftSince(baseline, now) : [];
    if (drift.length) {
      const what = drift.map((d) => `${d.slug}.${d.cols.join("/")}`).join(", ");
      if (r.killed) {
        for (const d of drift) {
          const patch = Object.fromEntries(d.cols.map((c) => [c, d.was[c]]));
          await svc.from("orgs").update(patch).eq("id", d.id);
        }
      }
      r = {
        ...r, ok: false, skipped: false, network: false,
        why: `LEFT REAL ORG SETTINGS CHANGED: ${what}` +
          (r.killed ? " — restored (killed before its teardown)" : " — NOT restored; fix its teardown"),
      };
    }
  }

  results.push(r);
  const mark = r.network
    ? "\x1b[33mNET \x1b[0m"
    : r.skipped
    ? "\x1b[33mSKIP\x1b[0m"
    : r.demoOnly
      ? "\x1b[36mDEMO\x1b[0m"
      : r.ok
        ? "\x1b[32mPASS\x1b[0m"
        : "\x1b[31mFAIL\x1b[0m";
  console.log(`${mark} ${r.name.padEnd(34)} ${String(r.secs).padStart(4)}s  ${r.why}`);
}

const skipped = results.filter((r) => r.skipped || r.network);
const failed = results.filter((r) => !r.ok && !r.skipped && !r.network);

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
