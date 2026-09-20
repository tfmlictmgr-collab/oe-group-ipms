import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Sliding-window rate limiting for the public intake webhooks, backed by Upstash
// Redis. Signature/secret verification (webhook-security.ts) is the *auth* layer;
// this is the *abuse* layer — it caps how fast a single sender (or a raw flood)
// can drive the expensive classify+write path (Anthropic tokens, DB inserts,
// outbound replies from our verified number).
//
// FAIL-OPEN BY DESIGN: if Upstash isn't configured (no env keys) or Redis errors,
// requests are ALLOWED. Rate limiting is a protection layer, not a gate — a
// limiter outage must not take intake down, and the demo (which has no Upstash
// keys) must keep working untouched. Contrast webhook-security.ts, which is auth
// and fails *closed* in production.
//
// ⚠️ **EXCEPT ON THE MONEY PATH, WHICH ALREADY FAILS CLOSED.** That is not a
// contradiction and it is not aspirational — it is what the four remittance
// call sites and the payment webhook already do today, by checking `degraded`
// below and refusing when the limiter was supposed to be running and is not:
//
//   • app/api/webhooks/payments/[gateway]  → 503 Service Unavailable
//   • lib/payout-actions.ts                → refuses, records nothing
//   • app/dashboard/ledger/payouts         → refuses
//   • app/dashboard/payments/[id]          → refuses
//   • app/dashboard/requisitions           → refuses
//
// Recorded here on 20 Sept 2026 because `GO_LIVE_CHECKLIST.md` §5 carried
// "decide whether high-risk routes need to fail closed" as an OPEN QUESTION
// long after the code had answered it. A control that exists but is documented
// as undecided gets re-litigated, or worse, "added" a second time. The split
// is deliberate: a tenant who cannot raise a ticket during a Redis outage is
// an inconvenience; an unlimited remittance endpoint during one is the
// incident.

type Duration = `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

let redis: Redis | null = null;
let redisResolved = false;

function getRedis(): Redis | null {
  if (redisResolved) return redis;
  redisResolved = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not configured → fail open
  redis = new Redis({ url, token });
  return redis;
}

// One Ratelimit instance per (namespace, limit, window) — reused across requests.
const limiters = new Map<string, Ratelimit>();

function getLimiter(name: string, limit: number, window: Duration): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;
  const key = `${name}:${limit}:${window}`;
  let l = limiters.get(key);
  if (!l) {
    l = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(limit, window),
      prefix: `rl:${name}`,
      analytics: false, // saves Redis commands; we don't need the dashboard
    });
    limiters.set(key, l);
  }
  return l;
}

export type RateResult = {
  allowed: boolean;
  remaining?: number;
  reset?: number;
  // true when limiting was not applied at all — either reason below.
  skipped?: boolean;
  // Which reason, because callers on money-moving routes need to tell them
  // apart: "never configured" is the expected, harmless state for local dev
  // and the POC demo (no Upstash keys) and must keep failing open exactly as
  // documented above. "Redis errored at call time" means limiting WAS
  // supposed to be active and is not, right now — a real degradation, not an
  // absence. A route that wants to fail closed checks THIS, never `skipped`
  // alone, or it would also refuse every request in an environment that was
  // never meant to have a limiter running.
  degraded?: boolean;
};

export async function checkRateLimit(
  name: string,
  identifier: string,
  limit: number,
  window: Duration
): Promise<RateResult> {
  const l = getLimiter(name, limit, window);
  if (!l) return { allowed: true, skipped: true };
  try {
    const res = await l.limit(identifier);
    return { allowed: res.success, remaining: res.remaining, reset: res.reset };
  } catch (err) {
    console.error(`rate-limit "${name}" error (failing open):`, err);
    return { allowed: true, skipped: true, degraded: true };
  }
}

// Best-effort client IP from the proxy chain (Vercel sets x-forwarded-for).
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

// Tunable defaults (env-overridable) shared by both intake webhooks.
// Coarse: sheds a raw volumetric flood per source IP before any expensive work.
// Per-sender: caps a single conversation's burst (loops/spam), generous for a human.
export const INTAKE_LIMITS = {
  coarsePerIp: {
    limit: Number(process.env.INTAKE_IP_LIMIT ?? 100),
    window: (process.env.INTAKE_IP_WINDOW ?? "10 s") as Duration,
  },
  perSender: {
    limit: Number(process.env.INTAKE_SENDER_LIMIT ?? 5),
    window: (process.env.INTAKE_SENDER_WINDOW ?? "10 s") as Duration,
  },
};

// Per-caller, on every route that moves money out — real transfers, not a
// public endpoint, so this is generous enough for a legitimate remittance day
// (many vendors in a row) while still capping a runaway loop or a compromised
// session. There was no limiter on this route at all before; see the
// fail-closed note there.
//
// ⚠️ **30 → 20, decided 20 Sept 2026 (build plan §2.6), and the number matters
// more than it looks.** The four call sites all share this one namespace keyed
// by user id, and there is no bulk-payout path — a payment officer settling
// twenty landlords performs twenty separate actions. So the ceiling is not
// "how many payments per day", it is "how fast can one person legitimately
// click".
//
// That is what makes a tighter number risky rather than obviously safer. One
// payout every 30 seconds is an ordinary brisk pace for someone working a
// list, and 10 per 5 minutes would refuse the eleventh — an outage invented on
// the first real payout day, in the one workflow where refusing looks like
// money going missing. A runaway loop or a scripted session does not do
// fifteen; it does hundreds per minute. Anything in the low twenties sits in
// the wide gap between those two, which is the whole point of the control.
//
// Raise or lower it without a code change by setting `REMITTANCE_LIMIT` on the
// deployment — it is in `GO_LIVE_CHECKLIST.md` §2 for exactly this reason.
export const REMITTANCE_LIMIT = {
  limit: Number(process.env.REMITTANCE_LIMIT ?? 20),
  window: (process.env.REMITTANCE_WINDOW ?? "5 m") as Duration,
};
