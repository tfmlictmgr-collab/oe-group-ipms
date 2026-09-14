// Next.js instrumentation hook — loads the right Sentry config per runtime.
// Enabled via `experimental.instrumentationHook` in next.config.mjs (Next 14).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Surfaces server-side React rendering errors to Sentry (no-op when disabled).
export { captureRequestError as onRequestError } from "@sentry/nextjs";
