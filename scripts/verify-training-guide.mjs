// The training handbook cannot silently go stale.
//
// `lib/guides/processes.ts` is a hand-written catalogue, and a hand-written
// catalogue drifts from the product exactly the way the navigation drifted
// from the permission matrix three times before `0132` made the menu ASK
// instead of hold its own array (see `verify-role-surface.mjs`'s own account
// of that history). This is the same fix applied to documentation: ask the
// live database which roles, capabilities, routes and B9 module flags exist,
// and fail when one of them has no process describing it.
//
// A gap here means someone can do something in the product that the training
// material never mentions — which is the exact failure mode a handbook exists
// to prevent. This is deliberately a hard failure (`verify-all.mjs` gate), not
// a warning: a warning nobody reads is how a handbook goes stale in the first
// place.
//
// Usage: node scripts/verify-training-guide.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { PROCESS_CATALOGUE } from "../lib/guides/processes.ts";
import { NAV_GROUPS } from "../components/shell/nav-config.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await db.connect();

console.log("The training handbook against the live system\n");

// ── A. Every role in the enum gets at least one process ───────────────────
// `viewer` and `payment_audit_approver`/`payment_approver` are read-only or
// desk-scoped roles with no journey of their own to RAISE — they appear as a
// STEP in other people's processes (an auditor reading the trail, a payment
// approver at their desk) rather than starting one. They are still required
// to show up in `roles` on at least one process; nothing is pre-exempted here,
// because that is exactly the shortcut that let three roles go undocumented
// in the navigation before `0132`.
const roles = (await db.query(`select unnest(enum_range(null::user_role))::text v`))
  .rows.map((r) => r.v);

const coveredRoles = new Set(PROCESS_CATALOGUE.flatMap((p) => p.roles));
for (const role of roles) {
  if (coveredRoles.has(role)) ok(`role "${role}" appears in the catalogue`);
  else bad(`role "${role}" has NO process in lib/guides/processes.ts`);
}

// ── B. Every configurable capability is exercised by some process ─────────
// Locked (non-delegable) capabilities are still required here: the training
// material is exactly where "this cannot be delegated" needs to be TAUGHT,
// not merely enforced in the database.
const caps = (await db.query(`select key from capabilities order by key`)).rows.map((r) => r.key);
const coveredCaps = new Set(PROCESS_CATALOGUE.flatMap((p) => p.capabilities));
for (const cap of caps) {
  if (coveredCaps.has(cap)) ok(`capability "${cap}" is covered`);
  else bad(`capability "${cap}" has NO process exercising it`);
}

// ── C. Every dashboard route the navigation can show is walked by some process
// Read from NAV_GROUPS directly rather than a second hand-kept list of routes —
// the same reason the menu itself now reads the matrix instead of an array.
const navRoutes = new Set(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))
);
const coveredRoutes = new Set(PROCESS_CATALOGUE.flatMap((p) => p.routes));
for (const route of navRoutes) {
  if (coveredRoutes.has(route)) ok(`route "${route}" is covered`);
  else bad(`route "${route}" has NO process walking through it`);
}

// ── D. Every B9 module flag actually in use is named by some process ──────
// Read the DISTINCT module keys `org_modules` actually holds, not a hand-typed
// list — the same lesson `0192` drew about `org_has_module`: a flag that
// exists only in someone's head cannot be checked against.
const flags = (await db.query(`select distinct module from org_modules order by module`))
  .rows.map((r) => r.module);
const coveredFlags = new Set(
  PROCESS_CATALOGUE.map((p) => p.requiresFeature).filter(Boolean)
);
for (const flag of flags) {
  if (coveredFlags.has(flag)) ok(`module flag "${flag}" gates a covered process`);
  else bad(`module flag "${flag}" gates NOTHING in the catalogue`);
}

await db.end();

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED — every role, capability, route and module flag has a process."
    : `\n${failures} FAILURE(S) — see FAIL lines above. Each names a process still to write in lib/guides/processes.ts.`
);
process.exit(failures === 0 ? 0 : 1);
