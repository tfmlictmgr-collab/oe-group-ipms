// Runs an OWASP ZAP scan in Docker, after the pre-flight clears the target.
//
// ⚠️ The pre-flight is invoked HERE rather than chained in package.json,
// because `&&` and `$npm_config_target` behave differently in PowerShell and
// bash — and a safety gate that silently does not run on one machine is worse
// than no gate. This works identically from either.
//
// Usage:  npm run pentest:baseline -- https://target
//         npm run pentest:full     -- https://target
//         npm run pentest:full     -- http://localhost:3000   (app served on this machine)
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ZAP_USER / ZAP_PASSWORD live in .env.local (security/README.md §2). The
// pre-flight loads that file in ITS OWN process, which never reached this one —
// so the full scan refused for missing credentials unless they had also been
// exported into the shell by hand. Only those two are forwarded to the
// container below; nothing else from .env.local leaves this process.
config({ path: path.join(rootDir, ".env.local"), quiet: true });
const [, , mode, ...rest] = process.argv;
const target = rest.find((a) => /^https?:\/\//.test(a));

if (!["baseline", "full"].includes(mode)) {
  console.error("Usage: node scripts/run-zap.mjs baseline|full <target-url>");
  process.exit(2);
}
if (!target) {
  console.error(`\nGive a target:\n  npm run pentest:${mode} -- https://your-target\n`);
  process.exit(2);
}

// ── 1. The gate ───────────────────────────────────────────────────────────
const pre = spawnSync(
  process.execPath,
  [path.join(rootDir, "scripts", "pentest-preflight.mjs"), "--target", target, "--mode", mode],
  { stdio: "inherit" }
);
if (pre.status !== 0) {
  console.error("\nPre-flight refused this target. The scan has NOT been run.\n");
  process.exit(1);
}

// ── 2. Docker must actually be there ──────────────────────────────────────
const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
if (docker.status !== 0) {
  console.error(
    "\nDocker is not available. ZAP runs as a container — see security/README.md §1.\n" +
    "Everything else (verify-security-posture, npm audit, k6) runs without it.\n"
  );
  process.exit(1);
}

// ── 3. Run it ─────────────────────────────────────────────────────────────
const reports = path.join(rootDir, "security", "reports");
fs.mkdirSync(reports, { recursive: true });

// A target on THIS machine has to be renamed for the container. Inside it,
// `localhost` is the container itself, so ZAP would scan nothing and report a
// clean bill of health for an app it never reached. `host.docker.internal` is
// the host as seen from a container (Docker Desktop provides it; `--add-host`
// makes it exist on Linux too).
//
// ⚠ The pre-flight above was deliberately given the ORIGINAL target. Its
// plain-HTTP rule admits `localhost` and nothing else, and rewriting the URL
// before the gate would mean the gate judged a string the operator never typed.
// Only the container sees the alias.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const targetUrl = new URL(target);
const isLocal = LOCAL_HOSTS.has(targetUrl.hostname);
let scanTarget = target.replace(/\/+$/, "");
if (isLocal) {
  targetUrl.hostname = "host.docker.internal";
  scanTarget = targetUrl.toString().replace(/\/+$/, "");
  console.log(`\nLocal target: the container will reach ${target} as ${scanTarget}\n`);
}

const plan = `automation-${mode}.yaml`;
const env = [
  "-e", `ZAP_TARGET=${scanTarget}`,
  ...(process.env.ZAP_USER ? ["-e", `ZAP_USER=${process.env.ZAP_USER}`] : []),
  ...(process.env.ZAP_PASSWORD ? ["-e", `ZAP_PASSWORD=${process.env.ZAP_PASSWORD}`] : []),
];

if (mode === "full" && !process.env.ZAP_USER) {
  console.error(
    "\nZAP_USER / ZAP_PASSWORD are not set. An active scan signed OUT only ever\n" +
    "reaches the sign-in page and will report a clean bill of health for an\n" +
    "application it never saw. Set them in .env.local — see security/README.md §2.\n"
  );
  process.exit(1);
}

console.log(`\nRunning ZAP ${mode} scan against ${target} …\n`);
const run = spawnSync("docker", [
  "run", "--rm",
  ...(isLocal ? ["--add-host", "host.docker.internal:host-gateway"] : []),
  "-v", `${path.join(rootDir, "security", "zap")}:/zap/wrk/plans:ro`,
  "-v", `${reports}:/zap/wrk/reports:rw`,
  ...env,
  "ghcr.io/zaproxy/zaproxy:stable",
  "zap.sh", "-cmd", "-autorun", `/zap/wrk/plans/${plan}`,
], { stdio: "inherit" });

console.log(
  run.status === 0
    ? `\nDone. Report in security/reports/ — triage per security/README.md §4.\n`
    : `\nZAP exited ${run.status}. A non-zero exit can mean findings were raised, ` +
      `not that the scan failed — read the report before concluding either.\n`
);
process.exit(run.status ?? 1);
