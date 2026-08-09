# Day 12 follow-ups — for PC1

Everything here came out of the 8–9 August pentest/load-test pass
(`docs/DAY12_SECURITY_PASS.md` §6). None of it is a blocking defect — the
database boundary, application boundary, and payment gate are all clean.
These are the items that were **deliberately not fixed live**, because each
either needs testing this pass didn't have time for, or a decision only a
human should make. Ordered roughly by "worth doing before go-live" first.

Each item below is self-contained: point an agent (or yourself) at one
section and it has everything needed to act, without re-reading the whole
Day 12 report first.

---

## 1. Rewrite `security/k6/rate-limit.js` — it doesn't test what it claims to

**File:** `security/k6/rate-limit.js`
**Root cause:** it `POST`s plain JSON to `/reset-password`, but that route's
real handler is `requestPasswordReset` in `app/reset-password/actions.ts` —
a Next.js **Server Action**, invoked only via a POST carrying a
build-specific `Next-Action: <digest>` header and an encoded-args body, not
a generic REST call. Confirmed with `curl -X POST .../reset-password`:
flat **405 Method Not Allowed**, before the request ever reaches
`requestPasswordReset` or the rate limiter inside it. That's why the script
reports `requests_refused: 0` after 1,000+ requests — it's not that nothing
is refused, it's that nothing real is ever attempted.

**The rate limiter itself is fine** — proven directly by
`node scripts/verify-rate-limit.mjs`, which calls `lib/rate-limit.ts`'s
logic the way the real app does (5/60s per sender, cuts off at request 6,
independent per sender, fails open when Redis isn't configured). That
script is the authoritative check until this one is fixed; don't read the
k6 threshold failure as a real gap.

**Two ways to fix it, pick one:**
- **(a) Retarget at a genuine REST endpoint.** These are real Next.js route
  handlers (not Server Actions) that also call `checkRateLimit`, so a plain
  POST actually reaches them:
  `app/api/webhooks/{telegram,whatsapp,email/resend,payments/[gateway]}/route.ts`.
  Whoever does this needs to pick one that's safe to hammer with synthetic,
  signature-invalid payloads (they should get refused for a *different*
  reason — bad signature — before or alongside the rate limit, so the
  assertion needs adjusting to match: refused-for-any-reason under abuse,
  not specifically HTTP 429).
- **(b) Properly invoke the Server Action protocol** against
  `/reset-password` — extract the current `Next-Action` digest (it changes
  per build, so this needs to happen at test-run time, not be hardcoded)
  and send the correctly-encoded action-args body. More faithful to the
  real code path finance-critical actions use, but more fragile to
  maintain.

(a) is probably the pragmatic choice. Whichever is picked, re-run it against
dev afterward and confirm `requests_refused` is actually nonzero under the
hammer scenario — that's the real acceptance test, not just "the script
exits 0."

---

## 2. Add a Content-Security-Policy header

**File:** `next.config.mjs` (`headers()`, alongside the `X-Frame-Options` /
`X-Content-Type-Options` entries already added this pass)
**Why it wasn't just added:** this app loads Paystack's checkout script,
Sentry's error tunnel (`/monitoring`), and whatever WhatsApp/Telegram
webhook-adjacent assets exist client-side. A CSP written without testing
each of those risks silently breaking checkout — on a system that moves
client money, that's not a Day 12 drive-by fix.

**What's needed:** enumerate every external script/style/connect-src this
app actually loads (start with Paystack's inline checkout, Sentry's tunnel,
any font/analytics CDN), build a CSP that allowlists exactly those, and
**manually test a full payment flow end-to-end** against it before merging
— report-only mode (`Content-Security-Policy-Report-Only`) first, for a day
or two of real traffic, is the safer rollout than going straight to
enforcing.

---

## 3. Verify the CORS wildcard doesn't reach authenticated routes

**Finding:** `Access-Control-Allow-Origin: *` is present on statically
generated public pages (e.g. `/reset-password`). This is Vercel's default
behaviour for static/ISR-cached HTML, not something in this repo's config —
confirmed nothing in `next.config.mjs` or `vercel.json` sets it.

**Why it's open, not closed:** the Day 12 ZAP baseline scan was
unauthenticated (by design — see `security/README.md` §2), so it never
touched `/dashboard/*` or any session-scoped route. It's architecturally
very likely dynamic, per-request pages don't get this header (Vercel only
applies it to static file-like responses), but that's inference, not a
measurement.

**What's needed:** log in, open dev tools' network tab (or `curl` with a
valid session cookie), and check the response headers on a couple of
authenticated dashboard routes (`/dashboard`, `/dashboard/payments`) for
`Access-Control-Allow-Origin`. If absent, close this out as confirmed-safe
in `docs/DAY12_SECURITY_PASS.md`. If present, that's a real finding needing
immediate attention — bare `ACAO: *` on a cookie-authenticated page is a
different risk category than on a public one.

---

## 4. Verify HSTS on the real custom domains

**Finding:** ZAP flagged `Strict-Transport-Security` missing on one path
(`/reset-password`); a direct `curl` to the same path returned the header
present (`max-age=63072000; includeSubDomains; preload`) — inconsistent,
likely cache-state-dependent, and on the `.vercel.app` domain, which isn't
what real users hit anyway.

**What's needed:** `curl -sI https://tfmlportal.com/reset-password` and
`curl -sI https://oeaportal.com/reset-password` (the actual aliases) and
confirm HSTS is present and consistent. If it is, note that in the report
and close it out. If it isn't on the domains that matter, that's worth
fixing — either via Vercel's domain-level HSTS setting or an explicit
header in `next.config.mjs`.

---

## 5. Fix or retire `verify-cross-org-dispatch`'s stale assumption

**File:** `scripts/verify-cross-org-dispatch.mjs`
**Not a security issue** — every actual cross-org isolation assertion in
this suite passes. The one failure: it tries to clear a ticket's
`assigned_to_user_id` to `null` and asserts that succeeds. It doesn't —
refused by the DB constraint added in
`supabase/migrations/0117_a_job_in_hand_has_a_hand.sql` ("a request cannot
be assigned with nobody assigned — dispatch it to a vendor or ops person
first"), which is working exactly as that migration intended. The test
predates the constraint.

**What's needed:** update the test's "a ticket can still be unassigned"
step to dispatch to a *different* vendor/ops person instead of clearing to
`null` (matching the real, current business rule), or remove the assertion
if there's no longer a legitimate "fully unassigned" state to test for.
Whoever touches this should confirm with whoever owns migration 0117's
intent before changing the assertion's meaning.

---

## 6. Decide: rate limiting on Preview deployments

**Not a bug — a product/ops decision.** Upstash's REST credentials
(`UPSTASH_REDIS_REST_URL`/`TOKEN`) are set on Vercel's **Production**
environment for `oe-group-ipms-dev` only, not Preview or Development.
`lib/rate-limit.ts` fails open by design when unconfigured ("a limiter
outage must not take intake down"), so any Preview/branch deployment
currently has **no enforced rate limiting** on the public intake webhooks
or password-reset.

**What's needed:** a decision, not code — either (a) accept this as-is
(matches the existing "the demo... must keep working untouched" stance in
`lib/rate-limit.ts`'s own comment), or (b) provision the same Upstash
database's credentials on Vercel's Preview environment too. If (b), it's a
five-minute Vercel dashboard change; record whichever choice in
`docs/DAY12_SECURITY_PASS.md` §6.4.

---

## Not on this list

Two false-positive/no-action items from the ZAP baseline (`X-Powered-By`
header, the "Big Redirect" size heuristic on `/`) and the `RequestResetForm`
discarded-result "failure" (a deliberate anti-enumeration design, not a
bug) are already closed out in `docs/DAY12_SECURITY_PASS.md` §6.1/§6.5 —
no need to revisit them.
