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
// FIXED 2026-08-09 (docs/DAY12_FOLLOWUPS.md #1): this used to POST plain JSON
// at `/reset-password`, but that route's handler is a Next.js Server Action,
// reachable only via a build-specific `Next-Action` header plus an encoded-
// args body — a plain POST bounces off routing with a flat 405 before it ever
// reaches the rate limiter, which is why the old script always reported
// `requests_refused: 0` no matter how hard it hammered.
//
// It was also asserting the wrong signal, and would have been even against a
// real REST target: NONE of this app's rate-limited routes ever answer 429.
// Every one of them is deliberately quiet under abuse — the intake webhooks
// return `200 "OK"` when the coarse per-IP gate trips (so Telegram/Meta/the
// payment gateways don't retry-storm a flood), and `/reset-password`'s own
// gate returns the SAME `ok()` as success, on purpose (anti-enumeration — a
// 429 there would confirm to a prober that an address was tried recently). So
// "refused" has to be read from behaviour, not a status code this system was
// built to never send.
//
// Retargeted at a real route handler — app/api/webhooks/telegram/route.ts —
// which calls checkRateLimit() on every POST, no Server Action involved. A
// synthetic hammer with no secret-token header is refused either way, but for
// two different reasons depending on whether the limiter has tripped yet:
//   - under the limit:  403 Forbidden  (missing/unknown Telegram secret token)
//   - over the limit:   200 "OK"       (the coarse per-IP gate trips first and
//                                       drops the request before the token
//                                       check ever runs)
// So the limiter firing is visible as the response FLIPPING from 403 to a
// literal 200 "OK" body — not as a 429 this route will never send. That flip,
// not a status code, is what this script now asserts.
//
// Keyed on source IP (clientIp in lib/rate-limit.ts), so this only ever trips
// the rate-limit bucket for the machine running the test — real Telegram
// traffic (a different source IP, carrying a real secret token) is untouched.
//
// Run:  npm run loadtest:ratelimit -- https://your-target
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.TARGET;
if (!BASE) throw new Error("Set TARGET");

// ⚠️ Same trap journey.js hit (fixed 2026-08-09): k6's default classifier
// counts every 4xx as a request failure, so the 403s this script deliberately
// provokes — the correct answer for a probe carrying no secret token — would
// be reported as `http_req_failed: ~22%` on a completely healthy run. There is
// no http_req_failed threshold here, so it wouldn't fail the run, but a
// security report is a bad place to leave a number that reads as a fifth of
// requests erroring when none did.
http.setResponseCallback(http.expectedStatuses(200, 403));

// 200 "OK", coarse per-IP gate tripped — the limiter refusing.
const rateLimited = new Counter("requests_rate_limited");
// 403, limiter not tripped yet — the normal, unlimited refusal (bad token).
const signatureRejected = new Counter("requests_signature_rejected");
const unexpected = new Counter("requests_unexpected");

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
    // If the response NEVER flips to the rate-limited shape after 1,200
    // requests from one source in 30 seconds, the limiter is not doing
    // anything.
    "requests_rate_limited": ["count>0"],
  },
};

export default function () {
  // A real route handler, not a Server Action — checkRateLimit runs on every
  // POST before anything else. No secret-token header is sent on purpose: it
  // is refused no matter what, the only question is which gate refuses it.
  const res = http.post(
    `${BASE}/api/webhooks/telegram`,
    JSON.stringify({ update_id: __ITER, message: { text: "loadtest probe — not a real update" } }),
    { headers: { "Content-Type": "application/json" }, redirects: 0, tags: { name: "tg-webhook-probe" } }
  );

  if (res.status === 200 && res.body === "OK") {
    rateLimited.add(1);
  } else if (res.status === 403) {
    signatureRejected.add(1);
  } else {
    unexpected.add(1);
  }

  check(res, { "no 5xx under abuse": (r) => r.status < 500 });
}
