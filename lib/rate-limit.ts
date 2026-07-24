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
  skipped?: boolean; // true when limiting was not applied (unconfigured/error)
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
    return { allowed: true, skipped: true };
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
