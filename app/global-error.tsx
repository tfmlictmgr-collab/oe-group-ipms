"use client";

// App Router global error boundary. Reports uncaught React render errors to
// Sentry (a no-op when Sentry has no DSN) and shows a minimal fallback. This is
// the last-resort boundary; route-level error.tsx files can handle finer cases.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#666" }}>
            The team has been notified. Please refresh and try again.
          </p>
        </div>
      </body>
    </html>
  );
}
