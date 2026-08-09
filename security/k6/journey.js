// k6 — the load profile this system actually sees.
//
// Not a flood of one URL. The Nigerian FM/property pattern is bursty and
// weekday-shaped: tenants report faults in the morning, staff triage through
// the day, and finance runs in concentrated batches at month end. A test that
// hammers `/login` measures Vercel's edge, not this application.
//
// ⚠️ READ-ONLY BY DESIGN. Every request here is a GET. This app writes through
// Server Actions, and a load test that fired them would create thousands of
// tickets, invoices and notifications in whatever database it was pointed at.
// Write throughput is covered by the verification suites, which write inside
// transactions and roll back.
//
// Run:  npm run loadtest -- https://your-target
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.TARGET;
if (!BASE) throw new Error("Set TARGET, e.g. TARGET=https://host k6 run journey.js");

const rateLimited = new Rate("rate_limited_429");
const signInTime = new Trend("t_sign_in_page");
const publicTime = new Trend("t_public_surface");

export const options = {
  scenarios: {
    // The ordinary weekday: a steady trickle with a mid-morning ramp.
    weekday: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "1m", target: 10 },
        { duration: "3m", target: 25 },
        { duration: "2m", target: 25 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // ⚠️ p(95) rather than an average. An average hides the tail, and the tail
    // is what a facility manager on a Lagos 3G connection actually experiences.
    "http_req_duration{expected_response:true}": ["p(95)<2500"],
    "http_req_failed": ["rate<0.02"],
    // A rate limit firing under ORDINARY load is a misconfiguration, not a
    // defence. Under the spike profile it is the opposite — see spike.js.
    "rate_limited_429": ["rate<0.01"],
  },
};

function get(path, tag) {
  const res = http.get(`${BASE}${path}`, {
    tags: { name: tag },
    redirects: 0,          // a 307 to /login is a valid answer, not a failure
  });
  rateLimited.add(res.status === 429);
  return res;
}

export default function () {
  group("public entry surfaces", () => {
    // What an anonymous visitor and a search engine can reach. These are the
    // only pages that must render without a session.
    const r = get("/login", "login");
    publicTime.add(r.timings.duration);
    check(r, {
      "login renders": (x) => x.status === 200,
      "no server error": (x) => x.status < 500,
    });
    signInTime.add(r.timings.duration);

    // Each brand's own front door (decision 12). Both must resolve, and
    // neither may leak the other's existence.
    for (const slug of ["tfml", "oea"]) {
      const o = get(`/o/${slug}`, "org-door");
      check(o, { [`/o/${slug} resolves`]: (x) => x.status === 200 });
    }

    // An unknown slug must 404 — the platform must not be mappable.
    const unknown = get("/o/definitely-not-a-real-org", "org-door-unknown");
    check(unknown, { "unknown org is 404": (x) => x.status === 404 });
  });

  group("authenticated surfaces refuse anonymously", () => {
    // ⚠️ This is a LOAD test that doubles as an access-control assertion, and
    // it is cheap: if any of these ever answers 200 without a session, the
    // isolation is gone and the load numbers stop mattering.
    for (const [path, tag] of [
      ["/dashboard", "dash"],
      ["/dashboard/payments", "dash-payments"],
      ["/dashboard/ledger", "dash-ledger"],
      ["/orgs", "orgs"],
    ]) {
      const r = get(path, tag);
      check(r, {
        [`${path} is not served anonymously`]: (x) => x.status === 307 || x.status === 302 || x.status === 401,
      });
    }
  });

  // Real people read, think, then click. Without this every VU behaves like a
  // scraper and the numbers describe a load nobody will ever generate.
  sleep(Math.random() * 3 + 1);
}

export function handleSummary(data) {
  return {
    "reports/k6-journey-summary.json": JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const p95 = m["http_req_duration"]?.values?.["p(95)"] ?? 0;
  const fail = (m["http_req_failed"]?.values?.rate ?? 0) * 100;
  const n = m["http_reqs"]?.values?.count ?? 0;
  return [
    "",
    "  OE Group IWMS — weekday load profile",
    `  requests        ${n}`,
    `  p(95) duration  ${p95.toFixed(0)} ms`,
    `  failed          ${fail.toFixed(2)} %`,
    `  429s            ${((m["rate_limited_429"]?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    "",
  ].join("\n");
}
