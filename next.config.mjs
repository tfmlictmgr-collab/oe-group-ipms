import { withSentryConfig } from "@sentry/nextjs";

// ── Content-Security-Policy, in REPORT-ONLY mode ────────────────────────────
//
// Shipped report-only on purpose (docs/DAY12_FOLLOWUPS.md #2). A Report-Only
// header cannot block anything — the browser evaluates it, reports what WOULD
// have been refused, and serves the page regardless. So this is safe to have
// live on a system that moves client money, and it is the only way to learn
// what a real policy would break before it breaks it. Promoting it to the
// enforcing `Content-Security-Policy` header is a deliberate, separate step
// once UAT has run against it with a clean console.
//
// What the browser actually loads from another origin, enumerated rather than
// guessed (2026-08-09):
//
//   * Cloudflare Turnstile — the only third-party <script> in the app
//     (app/apply/[orgId]/page.tsx), which also renders its own iframe.
//   * Supabase — REST, storage (org logos, work-order media) and realtime
//     (wss). Read from NEXT_PUBLIC_SUPABASE_URL so this follows the project
//     automatically at cutover instead of hardcoding dev's host.
//   * Sentry — NOT an external origin. `tunnelRoute: "/monitoring"` below
//     routes its browser traffic same-origin, so 'self' already covers it.
//
// ⚠️ Paystack needs NO entry here, which corrects the assumption recorded when
// this was first deferred ("a CSP risks silently breaking checkout"). Checkout
// is a top-level navigation — `window.location.href = checkoutUrl` in
// app/dashboard/my-rent/RentCharges.tsx — to Paystack's own hosted page. CSP
// governs subresources, frames and form posts; it does not restrict navigating
// away. Nothing Paystack serves is ever loaded INTO this origin.
//
// ⚠️ `'unsafe-inline'` in script-src is load-bearing and not laziness. Next 14's
// App Router emits inline hydration and flight-data scripts on every page, and
// nothing in this app uses CSP nonces (§4a of the Day 12 report already
// recorded that). Removing it means adopting nonces app-wide — a real piece of
// work, correctly sequenced with the Next 16 upgrade, not a cutover-week edit.
// The directives that DO bite without nonces are still worth having:
// frame-ancestors, object-src, base-uri and form-action each close a real
// class of attack on their own.
const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
  } catch {
    // Not set at build time (a bare `next build` with no env). Fall back to the
    // platform wildcard rather than emitting a policy that would report every
    // single Supabase call as a violation and drown the real signal.
    return "https://*.supabase.co";
  }
})();
const supabaseSocket = supabaseOrigin.replace(/^https:/, "wss:");

const cspReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Belt and braces with the X-Frame-Options: DENY below — that header is
  // obsolete in favour of this directive, and older browsers only understand
  // the header, so both are sent.
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  // Tailwind and every `style={{…}}` prop in the app are inline styles.
  "style-src 'self' 'unsafe-inline'",
  // data:/blob: cover the client-side image previews on evidence and document
  // upload before anything reaches storage.
  `img-src 'self' data: blob: ${supabaseOrigin}`,
  // ⚠️ Separate from img-src, and easy to miss: the work-order-media bucket
  // accepts image/* AND video/* (migration 0106), and a <video> is governed by
  // media-src, not img-src. Without this line every completion video a
  // technician uploaded would report a violation.
  `media-src 'self' blob: ${supabaseOrigin}`,
  // next/font/local — self-hosted, no external font CDN.
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseSocket} https://challenges.cloudflare.com`,
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  // ⚠️ No `upgrade-insecure-requests` here, deliberately. Browsers IGNORE it in
  // a report-only policy and log an error saying so — a permanent, meaningless
  // console error on every page, which is corrosive when the entire plan for
  // this header is "run UAT and have testers report console errors". The
  // Strict-Transport-Security header set below already forces HTTPS. Add this
  // directive when the policy is promoted to enforcing.
].join("; ");

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
    //
    // ⚠️ Found 2026-08-20: the portal's own "Submit Request" path
    // (app/dashboard/new/actions.ts, a server action calling
    // classifyMessageWithProvider directly, not through handle-inbound.ts)
    // hits the exact same gap and was never added here. It didn't crash —
    // loadSystemPrompt()'s try/catch (deliberately added after the webhook
    // incident above) caught the missing file and fell back to
    // `{ classification: FALLBACK_CLASSIFICATION, provider: "none" }`
    // silently, so every portal-submitted request landed as
    // general/normal/needs-human-review regardless of what was actually
    // typed — indistinguishable from "no AI key configured" unless you check
    // `tickets.classified_by`, which is what caught it.
    outputFileTracingIncludes: {
      "/api/webhooks/whatsapp/route": ["./docs/AURA_Triage_Classification_Prompt.md"],
      "/api/webhooks/telegram/route": ["./docs/AURA_Triage_Classification_Prompt.md"],
      "/dashboard/new": ["./docs/AURA_Triage_Classification_Prompt.md"],
    },
  },

  async headers() {
    return [
      {
        // Site-wide baseline, added after the Day 12 ZAP baseline pass flagged
        // their absence (docs/DAY12_SECURITY_PASS.md).
        source: "/:path*",
        headers: [
          // No legitimate reason to frame this app — nothing here embeds it,
          // and clickjacking a payment-approval or lease-signing screen is
          // exactly the scenario this exists to close off.
          { key: "X-Frame-Options", value: "DENY" },
          // Stop the browser from guessing content-types and executing an
          // uploaded document (work-order-media, application-documents) as
          // something other than what it was served as.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // ⚠️ HSTS is set HERE, by us, rather than left to the platform —
          // measured 2026-08-09 (docs/DAY12_FOLLOWUPS.md #4) and the two did
          // not agree. Vercel sends the full directive on its own
          // `*.vercel.app` host but only a bare `max-age=63072000` on the
          // custom domains, which are the ones real users actually hit:
          //
          //   oe-group-ipms-dev.vercel.app  max-age=63072000; includeSubDomains; preload
          //   tfmlportal.com                max-age=63072000
          //   oeaportal.com                 max-age=63072000
          //
          // Without `includeSubDomains` the apex is protected but
          // `anything.tfmlportal.com` is not — and a subdomain reached over
          // plain HTTP can set a cookie scoped to the parent domain, which is
          // the session-fixation shape HSTS exists to close. Checked before
          // adding it: neither apex publishes any web subdomain (only
          // oeaportal.com's registrar MX records, which HSTS does not touch),
          // so nothing breaks.
          //
          // `preload` is deliberately NOT sent. The token alone does nothing
          // until the domain is submitted to hstspreload.org, and that IS a
          // one-way door — removal from the browsers' built-in list takes
          // months. If OE Group wants it, submit deliberately and add the
          // token then.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // Report-only — see the long note above cspReportOnly. This one
          // cannot break a page; promoting it to "Content-Security-Policy" is
          // the separate, tested step.
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
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
