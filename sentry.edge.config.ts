// Sentry init for the Edge runtime (middleware, edge routes). Loaded via
// instrumentation.ts. Same DSN-gating as the server config.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  tracesSampleRate: 0.1,
  debug: false,
});
