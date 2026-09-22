// Two worlds sharing one Upstash database do not share their counters.
//
// Upstash's free tier allows exactly one database, so dev, staging and
// production share one Redis whether anyone intended it or not. The question
// this suite settles is whether they also share their COUNTERS — because
// `rl:intake-ip:<ip>` is the same key on every world, and if that is what gets
// written then a developer exercising intake from the office spends
// production's budget for that IP, and a load test on staging can lock a real
// tenant out of production.
//
// It reads the source rather than talking to Redis: the property is about the
// KEY the limiter is constructed with, and a live check would need three
// worlds' credentials to prove something a static read proves completely.
//
// Usage: node scripts/verify-rate-limit-namespace.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(rootDir, "lib", "rate-limit.ts");
const src = fs.readFileSync(SRC, "utf8");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

console.log("Rate-limit keys name the world they belong to\n");

console.log("A. The key carries a world");
const prefix = src.match(/prefix:\s*`([^`]+)`/)?.[1];
prefix
  ? ok(`found the limiter prefix: \`${prefix}\``)
  : bad("could not find a `prefix:` on the Ratelimit constructor — every check below is vacuous");

prefix && /\$\{worldTag\(\)\}/.test(prefix)
  ? ok("the prefix interpolates worldTag() — counters are per world")
  : bad(`the prefix does not name a world: \`${prefix}\` — every world shares one set of counters`);

prefix && /\$\{name\}/.test(prefix)
  ? ok("the prefix still distinguishes the limiters from each other")
  : bad("the prefix no longer carries the limiter name — intake and remittance would share a budget");

console.log("\nB. worldTag() derives from the world's own identity");
const fn = src.match(/function worldTag\(\)[\s\S]*?\n}/)?.[0] ?? "";
fn
  ? ok("worldTag() is defined in this file")
  : bad("worldTag() is missing — the prefix references something that does not exist");

/NEXT_PUBLIC_SUPABASE_URL/.test(fn)
  ? ok("it reads the Supabase project ref, which is already per-world")
  : bad("it does not read NEXT_PUBLIC_SUPABASE_URL — a hand-set namespace is one more thing to get wrong on four worlds");

/\{20\}/.test(fn)
  ? ok("it matches a 20-character ref, so a truncated URL yields the fallback rather than a partial key")
  : bad("the ref pattern is not pinned to 20 characters");

/\?\?\s*"unknown"/.test(fn)
  ? ok("an unreadable URL falls back to a namespace rather than throwing — this must never gate a request")
  : bad("no fallback: an unreadable Supabase URL would break rate limiting instead of degrading it");

console.log("\nC. The worlds this repository knows are genuinely distinct");
// Prove the premise rather than assert it: two worlds whose refs happened to
// be equal would make the whole mechanism a no-op, and use-env.mjs is where
// that would show up first.
const envSrc = fs.readFileSync(path.join(rootDir, "scripts", "use-env.mjs"), "utf8");
const refs = [...envSrc.matchAll(/^\s{2}(demo|dev|staging|prod):\s*"([a-z0-9]{20})"/gm)].map((m) => [m[1], m[2]]);
refs.length >= 2
  ? ok(`read ${refs.length} recorded project refs from use-env.mjs (${refs.map(([w]) => w).join(", ")})`)
  : bad("could not read at least two refs from use-env.mjs — cannot confirm the namespaces differ");

new Set(refs.map(([, r]) => r)).size === refs.length
  ? ok("every recorded ref is distinct, so every world gets its own namespace")
  : bad("two worlds share a project ref — they would share rate-limit counters too");

console.log("");
console.log(failures === 0
  ? "\x1b[32mALL CHECKS PASSED\x1b[0m — one Upstash database, one set of counters per world."
  : `\x1b[31m${failures} check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
