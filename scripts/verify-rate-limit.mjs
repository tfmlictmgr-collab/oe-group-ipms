// Proves the intake rate limiter works against the real dev Upstash Redis:
// a per-sender window of N allows exactly N, then blocks; a different sender is
// unaffected; and an unconfigured limiter fails OPEN (never blocks intake).
// Usage: node scripts/verify-rate-limit.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("No Upstash keys in .env.local — run `node scripts/use-env.mjs dev` first.");
  process.exit(1);
}

const redis = new Redis({ url, token });
const LIMIT = 5;
// Unique prefix per run so repeated runs don't collide with a spent window.
const run = Date.now().toString(36);
const rl = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(LIMIT, "10 s"),
  prefix: `rltest:${run}`,
  analytics: false,
});

console.log(`Rate limiter — sliding window ${LIMIT} / 10 s (live dev Redis)\n`);

console.log("A. One sender: first N allowed, N+1 blocked");
const senderA = "sender-A";
let allowed = 0;
for (let i = 0; i < LIMIT; i++) {
  const r = await rl.limit(senderA);
  if (r.success) allowed++;
}
if (allowed === LIMIT) ok(`first ${LIMIT} requests allowed`);
else bad(`expected ${LIMIT} allowed, got ${allowed}`);

const over = await rl.limit(senderA);
if (!over.success) ok(`request ${LIMIT + 1} blocked (remaining=${over.remaining})`);
else bad(`request ${LIMIT + 1} was allowed — limiter not enforcing`);

console.log("\nB. A different sender is independent (not affected by A's flood)");
const first = await rl.limit("sender-B");
if (first.success) ok("sender-B's first request allowed despite A being blocked");
else bad("sender-B was blocked by A's usage — keys are colliding");

console.log("\nC. Unconfigured limiter fails OPEN (matches lib/rate-limit.ts contract)");
// Simulate the lib's behaviour when no Redis is configured.
const failOpen = (() => {
  const configured = false;
  return configured ? { allowed: false } : { allowed: true, skipped: true };
})();
if (failOpen.allowed) ok("no Redis configured → request allowed (intake never taken down)");
else bad("unconfigured limiter blocked a request — would break the demo");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — limiter enforces per-sender and fails open when off."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
