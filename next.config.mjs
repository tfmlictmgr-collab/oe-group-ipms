import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Required in Next 14 so instrumentation.ts runs (loads Sentry per runtime).
    instrumentationHook: true,
    // ⚠️ lib/triage.ts reads docs/AURA_Triage_Classification_Prompt.md at
    // REQUEST time via readFileSync(process.cwd() + ...) — a pattern Next's
    // serverless file tracer (@vercel/nft) does not reliably detect, because
    // the path is assembled at runtime rather than statically imported. Without
    // this entry the file silently does not ship in the deployed function:
    // readFileSync then either throws ENOENT or (as happened in production,
    // 2026-08-05) reads something that doesn't match the expected fence and
    // throws "Could not find a fenced system prompt block" — uncaught, because
    // that call sits outside classifyMessage's try/catch, which crashed EVERY
    // inbound WhatsApp/Telegram message that needed fresh classification
    // (a genuinely new ticket) while leaving already-open-thread replies
    // (follow-up/status/pleasantry, which never call it) looking fine. This
    // explicitly guarantees the file is bundled for both webhook routes.
    outputFileTracingIncludes: {
      "/api/webhooks/whatsapp/route": ["./docs/AURA_Triage_Classification_Prompt.md"],
      "/api/webhooks/telegram/route": ["./docs/AURA_Triage_Classification_Prompt.md"],
    },
  },

  async headers() {
    return [
      {
        // A resume link carries its token in the query string — the same shape as
        // a password-reset link, and with the same exposure: any outbound request
        // from the page would put the full URL in a Referer header. Nothing here
        // loads from another origin today, but the header costs nothing and the
        // token is worth an entire application's personal data.
        source: "/tenancy/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          // Nor should a draft application be sitting in a shared cache.
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

// Sentry build-time wrapper. Source-map upload is disabled: it needs a
// SENTRY_AUTH_TOKEN + the @sentry/cli binary, and we're only doing error
// tracking for now — errors still report with minified stacks. Turn upload on
// later (Day 12) by adding the token and flipping sourcemaps.disable.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true, // no noisy Sentry logs during build
  sourcemaps: { disable: true },
  // Route Sentry's browser requests through a same-origin path so ad-blockers
  // don't drop client error reports.
  tunnelRoute: "/monitoring",
  disableLogger: true,
});
