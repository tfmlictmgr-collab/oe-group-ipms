// Switch which world `.env.local` points at, so a single working copy can drive
// any of the isolated Supabase worlds without hand-editing secrets.
//
//   node scripts/use-env.mjs demo      → the frozen POC/demo Supabase (never migrate this)
//   node scripts/use-env.mjs dev       → the Phase-1 dev Supabase
//   node scripts/use-env.mjs staging   → the production-preview Supabase (rehearsal, no real data)
//   node scripts/use-env.mjs prod      → the real production Supabase (once cutover has happened)
//   node scripts/use-env.mjs           → show which world is active
//
// Backing files (all gitignored): .env.demo.local, .env.dev.local,
// .env.staging.local, .env.prod.local — create the one you need before
// switching to it. This script only ever COPIES a file to .env.local; it never
// reads or writes data in any Supabase project, and never copies one world's
// secrets into another's backing file.
import fs from "node:fs";

// Project refs, filled in once each project exists. They do two jobs: they
// label the active world in `active()`, and they are the recorded answer that
// a backing file is checked AGAINST before any switch — a `.env.<world>.local`
// naming a different project than the one recorded here is refused rather than
// copied, because the whole value of this tool is that what it says and what it
// does are the same thing.
//
// A ref that is not yet recorded never blocks switching to that world; the
// backing file is enough. It only means this script cannot confirm the project
// is the one that was signed off.
const HOSTS = {
  demo: "egqzjrmzxqqxrrqpdwbt",
  dev: "uszwigxdvjlwcwkjsjmc",
  staging: "tjboghjzbalxwhhatogl",

  // ⚠️ Fill this in at Stage 3.1 — the moment the production Supabase project
  // exists, before anything is pointed at it. It is `null` rather than a
  // commented-out line so that the slot is visibly EMPTY rather than absent:
  // a missing key reads as "prod is not a thing here", which is how a world
  // ends up unlabelled in the one tool whose job is to say which world you are
  // on. `active()` below still names prod correctly while this is null, by
  // reading `.env.prod.local` itself — but only the ref recorded here proves
  // the project you are pointed at is the project that was signed off.
  prod: null,
};

// Where each world's secrets live. Read rather than assumed, so `active()` can
// name a world whose ref is not yet recorded above, and so the mismatch guard
// below has something to compare against.
const BACKING = (world) => `.env.${world}.local`;

const refIn = (file) => {
  if (!fs.existsSync(file)) return null;
  const m = fs
    .readFileSync(file, "utf8")
    .match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?https:\/\/([a-z0-9]+)\./);
  return m?.[1] ?? null;
};

// Worlds this script knows how to switch to. Separate from HOSTS so a world
// can be switched to before its ref is known for display purposes.
const WORLDS = ["demo", "dev", "staging", "prod"];

// ⚠️ The value may be QUOTED — `NEXT_PUBLIC_SUPABASE_URL="https://…"` is valid
// dotenv and is what `vercel env pull` writes. The original pattern required the
// URL to follow `=` immediately, so a quoted file matched nothing and this
// reported **"unknown (unset)"** — which reads as "no world is configured" when
// the truth was "staging, and I could not tell you". On 28 Aug 2026 that cost a
// session: `.env.local` was on staging while migrations were being applied to
// dev with `--world dev`, and the one command whose entire job is to answer
// "which world am I on" answered "unset".
//
// That is the same failure this repo has now written three incident notes about
// (INCIDENT_2026-08-05_PROD_ALIAS, INCIDENT_2026-08-06_DEMO_DB_MIGRATED, and
// migrate.mjs's own header) — not a wrong answer, but a **silent absence of
// one** from the tool meant to prevent exactly that.
//
// Optional whitespace and optional single/double quotes.
const active = () => {
  const cur = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  const m = cur.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?https:\/\/([a-z0-9]+)\./);
  const ref = m?.[1];
  if (!ref) {
    return cur.trim() === ""
      ? "unset (.env.local is missing or empty)"
      : "UNREADABLE — .env.local exists but names no Supabase URL this script can parse";
  }
  const named = Object.entries(HOSTS).find(([, r]) => r === ref)?.[0];
  if (named) return named === "prod" ? `PRODUCTION (${ref})` : named;

  // Not a recorded ref. Before answering "unknown", ask the backing files —
  // `.env.prod.local` names production perfectly well before anyone has got
  // round to recording the ref above, and "unknown" about PRODUCTION is the
  // worst possible answer from this tool. It is the exact failure the block
  // above describes: not a wrong answer, a silent absence of one.
  const fromFile = WORLDS.find((w) => refIn(BACKING(w)) === ref);
  if (fromFile === "prod") {
    return `PRODUCTION (${ref}) — ⚠️ ref not recorded in HOSTS yet, see Stage 3.1`;
  }
  if (fromFile) return `${fromFile} (${ref}) — ref not recorded in HOSTS`;

  return `unknown (${ref})`;
};

const target = process.argv[2];
if (!target) {
  console.log(`Active world: ${active()}`);
  process.exit(0);
}
if (!WORLDS.includes(target)) {
  console.error(`Unknown world "${target}". Use: ${WORLDS.join(" | ")}`);
  process.exit(1);
}
const file = BACKING(target);
if (!fs.existsSync(file)) {
  console.error(
    `Missing ${file}. Create it first (it holds that world's secrets) — ` +
    `never by copying another world's file, always from the project's own dashboard.`
  );
  process.exit(1);
}

// ⚠️ Rule 8, enforced rather than written down: "secrets are generated at the
// destination, never copied between worlds."
//
// The mistake this catches is the plausible one, not the careless one —
// copying `.env.staging.local` to `.env.prod.local` and editing it, then
// missing a line. The result is a file LABELLED prod that points somewhere
// else, and every guard downstream that asks "which project is this" gets the
// truth and answers correctly about the wrong world. `migrate.mjs` would
// happily migrate staging while the operator believed they were on production;
// `bootstrap-production.mjs` would refuse, but only by luck of staging being on
// its never-list.
//
// Checked here because this is the one place that reads these files knowing
// which world each is SUPPOSED to be.
const ref = refIn(file);
const clash = WORLDS.filter((w) => w !== target).find((w) => refIn(BACKING(w)) === ref);
if (ref && clash) {
  console.error(
    `Refusing to switch: ${file} names the SAME Supabase project as ${BACKING(clash)}.\n\n` +
    `  ${file} → ${ref}\n` +
    `  ${BACKING(clash)} → ${ref}\n\n` +
    `  Two worlds cannot share a project. This is almost always a backing file\n` +
    `  copied from another world and not fully edited — rebuild ${file} from the\n` +
    `  ${target} project's own dashboard rather than from another world's file.`
  );
  process.exit(1);
}

// A recorded ref that disagrees with the backing file means one of the two is
// stale. Refusing is right: the whole value of this tool is that what it says
// and what it does are the same thing.
if (ref && HOSTS[target] && HOSTS[target] !== ref) {
  console.error(
    `Refusing to switch: ${file} does not name the project recorded for "${target}".\n\n` +
    `  recorded in HOSTS : ${HOSTS[target]}\n` +
    `  ${file} names     : ${ref}\n\n` +
    `  Either the project was rotated and HOSTS is stale, or this backing file is\n` +
    `  pointed at the wrong project. Fix the one that is wrong before switching.`
  );
  process.exit(1);
}

fs.copyFileSync(file, ".env.local");

if (target === "prod") {
  // Loud on purpose. Every other world is a place to make mistakes; this one
  // holds real tenants, real money and real identity documents. Three incident
  // notes in this repository start with a stale pointer nobody read.
  console.log("");
  console.log("\x1b[41m\x1b[97m  ⚠️  .env.local NOW POINTS AT PRODUCTION  \x1b[0m");
  console.log("");
  console.log(`  project : ${ref ?? "(unreadable)"}${HOSTS.prod ? "" : "   ⚠️  not yet recorded in HOSTS — Stage 3.1"}`);
  console.log("  ⚠️  `npm run seed` has NO legitimate use here, ever (rule 1).");
  console.log("  ⚠️  Read this ref back and compare it before any migrating or");
  console.log("      deploying command — do not trust that you remember it.");
  console.log("");
} else {
  console.log(`Switched .env.local → ${target} (${HOSTS[target] ?? ref ?? "ref not recorded yet"})`);
}
console.log("Reminder: restart the dev server so it reloads env.");
