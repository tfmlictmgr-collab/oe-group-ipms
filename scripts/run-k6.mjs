// Runs a k6 profile against a target.
//
// Read-only by design (see security/k6/journey.js), so there is no destructive
// pre-flight here — but the target is still echoed and confirmed, because
// pointing a spike test at the wrong host is its own kind of incident.
//
// Usage:  npm run loadtest -- https://target
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [, , profile, ...rest] = process.argv;
const target = rest.find((a) => /^https?:\/\//.test(a));

const PROFILES = { journey: "journey.js", spike: "spike.js", "rate-limit": "rate-limit.js" };
if (!PROFILES[profile]) {
  console.error(`Usage: node scripts/run-k6.mjs ${Object.keys(PROFILES).join("|")} <target-url>`);
  process.exit(2);
}
if (!target) {
  console.error(`\nGive a target:\n  npm run loadtest -- https://your-target\n`);
  process.exit(2);
}

const k6 = spawnSync("k6", ["version"], { stdio: "ignore" });
if (k6.status !== 0) {
  console.error("\nk6 is not installed — see security/README.md §1 (`winget install k6`).\n");
  process.exit(1);
}

fs.mkdirSync(path.join(rootDir, "security", "reports"), { recursive: true });

console.log(`\nk6 "${profile}" against ${target}`);
if (profile === "spike") {
  console.log("⚠️  Expect 429s. This profile asserts the app SHEDS load rather than serving it all.");
}
if (profile === "rate-limit") {
  console.log("⚠️  This one FAILS if nothing is refused — that is the whole point of it.");
}
console.log("");

const run = spawnSync("k6", ["run", path.join(rootDir, "security", "k6", PROFILES[profile])], {
  stdio: "inherit",
  env: { ...process.env, TARGET: target },
  cwd: path.join(rootDir, "security"),
});
process.exit(run.status ?? 1);
