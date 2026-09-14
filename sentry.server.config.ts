// Sentry init for the Node.js server runtime. Loaded via instrumentation.ts.
// DSN comes from env — when it's absent (e.g. the demo, which carries no DSN),
// `enabled` is false and the SDK sends nothing. So adding Sentry to the Phase-1
// branch cannot start reporting from an environment that wasn't given a DSN.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  // Keep trace sampling modest — this is error tracking first, not full APM.
  tracesSampleRate: 0.1,
  // Don't spam the console locally when there's no DSN.
  debug: false,
});
