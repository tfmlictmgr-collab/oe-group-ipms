// k6 — does the rate limiter actually limit?
//
// ⚠️ A separate file because its pass condition is the inverse of every other
// load test here: this one FAILS if nothing is refused.
//
// `lib/rate-limit.ts` fails OPEN everywhere except remittance execution, which
// fails CLOSED. That is a deliberate trade — a Redis outage must not stop a
// tenant reporting a burst pipe, but it must stop money moving unwatched. The
// consequence is that a limiter which is silently misconfigured, or an Upstash
// credential which is missing on the new production project, looks exactly like
// a healthy system right up until someone abuses it.
//
// This is the check that tells the two apart, and it is why it must be run
// against PRODUCTION after cutover rather than only on dev.
//
// Run:  npm run loadtest:ratelimit -- https://your-target
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.TARGET;
if (!BASE) throw new Error("Set TARGET");

const refused = new Counter("requests_refused");
const served = new Counter("requests_served");

export const options = {
  scenarios: {
    // One virtual user, hammering as fast as it can from a single source —
    // which is what an abusive client looks like.
    hammer: {
      executor: "constant-arrival-rate",
      rate: 40,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: {
    // If NOTHING was refused after 1,200 requests from one source in 30
    // seconds, the limiter is not doing anything.
    "requests_refused": ["count>0"],
  },
};

export default function () {
  // The password-reset request path is rate limited per-IP AND per-email
  // (0139's actions), which makes it the cleanest place to observe the limiter
  // without writing anything: an unknown address is always answered ok() by
  // design, so nothing is created and no mail is sent.
  const res = http.post(
    `${BASE}/reset-password`,
    JSON.stringify({ email: `loadtest-${__VU}-${__ITER}@example.invalid` }),
    { headers: { "Content-Type": "application/json" }, redirects: 0, tags: { name: "reset-probe" } }
  );
  if (res.status === 429) refused.add(1);
  else served.add(1);
  check(res, { "no 5xx under abuse": (r) => r.status < 500 });
}
