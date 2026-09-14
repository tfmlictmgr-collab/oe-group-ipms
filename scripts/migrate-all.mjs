// Apply pending schema migrations to several worlds in one sitting, so
// dev/staging/production cannot quietly drift apart — one runs `npm run
// migrate`, forgets the others exist, and staging stops being a true preview
// of production without anyone deciding that on purpose.
//
// SCHEMA ONLY. This calls scripts/migrate.mjs once per world, unchanged —
// same idempotent, ordered, transactional runner, same refusal of the frozen
// demo and of a mismatched .env.local. It never runs `npm run seed` and never
// reads or writes a data row in any project; nothing here copies data between
// worlds, ever. If you want that, you don't want this script.
//
// Usage: node scripts/migrate-all.mjs dev staging
//        node scripts/migrate-all.mjs staging prod
//
// Restores whichever world was active in .env.local before it ran, whether
// this succeeds or fails partway through.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const NEVER = new Set(["demo"]); // the frozen POC demo — migrate.mjs also refuses this; blocked here too, earlier and louder.
const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error("Usage: node scripts/migrate-all.mjs <world> [<world> ...]  e.g. dev staging");
  process.exit(1);
}
for (const w of targets) {
  if (NEVER.has(w)) {
    console.error(`Refusing: "${w}" is the frozen POC demo — it is never a migration target.`);
    process.exit(1);
  }
  if (!fs.existsSync(`.env.${w}.local`)) {
    console.error(`Missing .env.${w}.local — create it before including "${w}" here.`);
    process.exit(1);
  }
}

const original = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : null;
const restore = () => {
  if (original !== null) fs.writeFileSync(".env.local", original);
};
process.on("exit", restore); // restores even if a step below throws or process.exit()s early

let failed = null;
for (const w of targets) {
  console.log(`\n── ${w} ──────────────────────────────────────────────`);
  fs.copyFileSync(`.env.${w}.local`, ".env.local");
  const result = spawnSync("node", ["scripts/migrate.mjs"], { stdio: "inherit" });
  if (result.status !== 0) {
    failed = w;
    break;
  }
}

if (failed) {
  console.error(`\nStopped: migration failed on "${failed}". Worlds after it in the list were not attempted.`);
  console.error(`Fix the failure on "${failed}" and re-run — migrate.mjs is idempotent, so already-applied worlds simply skip what's done.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll of ${targets.join(", ")} are at the same migration state.`);
}
