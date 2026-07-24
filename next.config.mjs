import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Required in Next 14 so instrumentation.ts runs (loads Sentry per runtime).
    instrumentationHook: true,
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
