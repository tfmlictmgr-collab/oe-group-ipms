// Switch which world `.env.local` points at, so a single working copy can drive
// either the frozen demo DB or the Phase-1 dev DB without hand-editing secrets.
//
//   node scripts/use-env.mjs demo   → point at the POC/demo Supabase (read-only in spirit)
//   node scripts/use-env.mjs dev    → point at the Phase-1 dev Supabase
//   node scripts/use-env.mjs        → show which world is active
//
// Backing files (all gitignored): .env.demo.local, .env.dev.local
import fs from "node:fs";

const HOSTS = {
  demo: "egqzjrmzxqqxrrqpdwbt",
  dev: "uszwigxdvjlwcwkjsjmc",
};
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
if (!(target in HOSTS)) {
  console.error(`Unknown world "${target}". Use: demo | dev`);
  process.exit(1);
}
const file = `.env.${target}.local`;
if (!fs.existsSync(file)) {
  console.error(`Missing ${file}. Create it first (it holds that world's secrets).`);
  process.exit(1);
}
fs.copyFileSync(file, ".env.local");
console.log(`Switched .env.local → ${target} (${HOSTS[target]})`);
console.log("Reminder: restart the dev server so it reloads env.");
