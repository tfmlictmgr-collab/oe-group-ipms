// Sentry init for the browser. Runs on every page load. The DSN is public
// (write-only ingestion key) so it's safe in client code; when it's absent the
// SDK is disabled and nothing is sent.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Session Replay is off by default — it captures user sessions and needs a
  // privacy pass (NDPA) before enabling. Revisit in the Day 12 compliance work.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  debug: false,
});
