// Guards the rule that server actions must not throw their user-facing reasons.
//
// Next.js replaces the message of any error thrown in a Server Action with an
// opaque digest in production. `next dev` shows the real message, so this fault
// is invisible in every environment except the one that matters — which is
// exactly why it needs a check rather than a code review.
//
// This is a static audit, not a runtime one. It cannot prove a toast renders;
// it proves the invariant that makes the toast possible.
//
// Usage: node scripts/verify-action-errors.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// Throws that are CORRECT: unreachable states during a server render, where
// masking is the desired behaviour. Anything else must be a returned result.
const ALLOWED_THROWS = new Set([
  "app/dashboard/assets/actions.ts",           // buildImportContext — server render only
  "app/pay/[reference]/actions.ts",            // dev-only route; 404s in production
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(path.join(root, "app"));
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const actionFiles = files.filter((p) => {
  const src = fs.readFileSync(p, "utf8");
  return /^\s*["']use server["']/m.test(src);
});

console.log("Server actions — failures must be returned, not thrown\n");

console.log(`A. Every "use server" file was found (${actionFiles.length})`);
actionFiles.length >= 10
  ? ok(actionFiles.map(rel).length + " action modules audited")
  : bad(`only ${actionFiles.length} found — the audit is probably not scanning correctly`);

console.log("\nB. No action throws a message meant for a user");
for (const p of actionFiles) {
  const r = rel(p);
  const src = fs.readFileSync(p, "utf8");
  const throws = [...src.matchAll(/throw new Error\((.*)/g)];
  if (throws.length === 0) { ok(`${r} — none`); continue; }
  if (ALLOWED_THROWS.has(r)) {
    ok(`${r} — ${throws.length} throw(s), documented as server-render-only`);
    continue;
  }
  bad(`${r} throws ${throws.length} time(s): ${throws.map((t) => t[1].slice(0, 48)).join(" | ")}`);
}

console.log("\nC. Actions that can fail return a discriminated result");
for (const p of actionFiles) {
  const r = rel(p);
  if (ALLOWED_THROWS.has(r)) continue;
  const src = fs.readFileSync(p, "utf8");
  const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  if (exported.length === 0) continue;
  /from "@\/lib\/action-result"/.test(src)
    ? ok(`${r} — ${exported.length} action(s) use ActionResult`)
    : bad(`${r} does not import the result helpers`);
}

console.log("\nD. No client discards a result it should have checked");
{
  // The dangerous shape is a bare `await someAction(...)` as a statement: the
  // failure is returned, nobody looks at it, and the button appears to work
  // while nothing happened. Two shapes are correct — wrapping in runAction(),
  // or assigning and narrowing on `.ok` — so both are accepted.
  const clientFiles = files.filter((p) => /^\s*["']use client["']/m.test(fs.readFileSync(p, "utf8")));
  const actionNames = new Set();
  for (const p of actionFiles) {
    if (ALLOWED_THROWS.has(rel(p))) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const m of src.matchAll(/export async function (\w+)/g)) actionNames.add(m[1]);
  }

  const swallowed = [];
  for (const p of clientFiles) {
    const src = fs.readFileSync(p, "utf8");
    for (const name of actionNames) {
      for (const m of src.matchAll(new RegExp(`(.{0,40})await\\s+${name}\\s*\\(`, "g"))) {
        const before = m[1];
        if (/runAction\(\s*$/.test(before)) continue;         // unwrapped by helper
        // Assigned to something — check the file narrows on that name's `.ok`.
        const assign = before.match(/(?:const|let)\s+(\w+)\s*=\s*$/);
        if (assign && new RegExp(`\\b${assign[1]}\\.ok\\b`).test(src)) continue;
        swallowed.push(`${rel(p)} → ${name}`);
      }
    }
  }
  swallowed.length === 0
    ? ok("every action result is either unwrapped or explicitly checked")
    : bad(`result discarded: ${swallowed.join(", ")}`);
}

console.log("\nE. The helpers themselves are where they should be");
for (const f of ["lib/action-result.ts", "lib/run-action.ts"]) {
  fs.existsSync(path.join(root, f)) ? ok(f) : bad(`${f} is missing`);
}

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a user-facing failure reaches the user.\n" +
      "(Static audit: it proves failures are returned, not that a toast renders.)"
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
