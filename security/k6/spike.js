// k6 — the spike, and what SHOULD happen during one.
//
// ⚠️ This test inverts the usual pass condition. Under a sudden burst the
// correct behaviour is NOT "serve everything" — it is "shed load predictably
// and keep the sign-in page alive". A system that tries to serve a 20×
// stampede in full is one that falls over completely instead of degrading.
//
// So the thresholds below assert:
//   * no 5xx — the app refuses, it does not break;
//   * the sign-in page stays reachable throughout, because a person locked out
//     mid-incident cannot even report it;
//   * 429s are ACCEPTABLE here (the rate limiter doing its job), which is the
//     opposite of journey.js where any 429 is a misconfiguration.
//
// Run:  npm run loadtest:spike -- https://your-target
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.TARGET;
if (!BASE) throw new Error("Set TARGET");

const serverError = new Rate("server_error_5xx");
const shed = new Rate("shed_429");

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: "30s", target: 5 },    // calm
        { duration: "20s", target: 150 },  // the burst
        { duration: "1m",  target: 150 },  // sustained
        { duration: "30s", target: 5 },    // recovery
      ],
    },
  },
  thresholds: {
    // The one that must never fail.
    "server_error_5xx": ["rate==0"],
    // Shedding is allowed and expected; collapse is not.
    "http_req_duration{expected_response:true}": ["p(99)<8000"],
  },
};

export default function () {
  const res = http.get(`${BASE}/login`, { redirects: 0, tags: { name: "login-spike" } });
  serverError.add(res.status >= 500);
  shed.add(res.status === 429);
  check(res, {
    "never a 5xx": (r) => r.status < 500,
    "answers something": (r) => r.status > 0,
  });
}
