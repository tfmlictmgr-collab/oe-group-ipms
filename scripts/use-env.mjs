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

// Project refs, filled in once each project exists — used only to label the
// active world in `active()`. A missing ref here just means the display falls
// back to "unknown (<ref>)"; it never blocks switching TO that world, which
// only needs the backing .env.<world>.local file to exist.
const HOSTS = {
  demo: "egqzjrmzxqqxrrqpdwbt",
  dev: "uszwigxdvjlwcwkjsjmc",
  staging: "tjboghjzbalxwhhatogl",
  // prod:    "<fill in once the production Supabase project exists — GO_LIVE_CHECKLIST.md>",
};

// Worlds this script knows how to switch to. Separate from HOSTS so a world
// can be switched to before its ref is known for display purposes.
const WORLDS = ["demo", "dev", "staging", "prod"];

const active = () => {
  const cur = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  const m = cur.match(/NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]+)\./);
  const ref = m?.[1];
  return Object.entries(HOSTS).find(([, r]) => r === ref)?.[0] ?? `unknown (${ref ?? "unset"})`;
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
const file = `.env.${target}.local`;
if (!fs.existsSync(file)) {
  console.error(
    `Missing ${file}. Create it first (it holds that world's secrets) — ` +
    `never by copying another world's file, always from the project's own dashboard.`
  );
  process.exit(1);
}
fs.copyFileSync(file, ".env.local");
console.log(`Switched .env.local → ${target} (${HOSTS[target] ?? "ref not recorded yet"})`);
console.log("Reminder: restart the dev server so it reloads env.");
