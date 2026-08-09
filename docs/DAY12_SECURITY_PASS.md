# Day 12 — Security pass

**Run:** 8–9 August 2026, against the Phase-1 dev deployment
(`oe-group-ipms-dev`, aliased by `tfmlportal.com` / `oeaportal.com`) and its
Supabase project. The 8th covered the database and application boundary
(§2–§5 below); the 9th added the penetration test and load test (§6),
run from PC2 once Docker/WSL2/k6 were installed there.

> ⚠️ **This is not the go-live run.** `GO_LIVE_CHECKLIST.md` requires the Day 12
> pass to target the **production** URL and the **production** Supabase project,
> neither of which exists yet. Everything below re-runs unchanged against
> production once it does — `scripts/verify-security-posture.mjs` takes its
> target from the environment, so pointing it at production is a matter of
> credentials, not code.

---

## 1. Verdict

| Area | Result |
|---|---|
| Database boundary (RLS, anon reachability, audit trail, storage) | ✅ **Pass** — 30 checks |
| Application boundary (auth, gates, org isolation, roles) | ✅ **Pass** — the standing suites, ~600 checks (2 items below, neither a leak) |
| Dependencies | ⚠️ **Two accepted risks**, both recorded below |
| Secrets | ✅ **Pass** — no credential in the repository, confirmed with `gitleaks` (4 hits, all false positives) |
| ZAP baseline (passive, dev) | ✅ **Pass** — 0 High, 3 Medium; **all three now fixed or closed**, see §6.6 |
| k6 load test (dev) | ✅ **Pass** — weekday profile and spike both clean after fixing a bug in the test script itself |
| Rate limiter (direct, `verify-rate-limit.mjs`) | ✅ **Pass** — cuts off at request 6, per-sender independence, fails open when unconfigured |
| k6 rate-limit check (`loadtest:ratelimit`) | ✅ **Pass** — script rewritten 9 Aug; 978 of 1,191 requests refused, see §6.6 |
| ZAP full (active) | ⛔ **Not run** — needs empty production, which doesn't exist yet |
| External penetration test | ⛔ **Not done** — needs a third party and written authorisation |

**No blocking technical defect was found.** The two dependency items are
judgement calls for the board, not bugs, and both are argued below rather than
waved through. §6 has one real, fixed defect (a notification action silently
swallowing its own errors) and several accepted/deferred items — none of them
a hole in access control or the payment gate.

---

## 2. The database boundary

`scripts/verify-security-posture.mjs` — new, and written to be re-run at
cutover.

- **Row-level security is on for every table in `public`.** No exceptions.
- **An anonymous caller holding the public key reaches nothing.** Tested by
  doing it, against 17 tables covering people, money, the ledger, the client
  list, applications, leases, bank accounts and the audit trail. Every read
  returned zero rows; a delete and an update against `audit_log` affected zero
  rows; an insert was refused; and `operator_provision_org` refused with *"only
  an administrator of the OE Group operator organisation may provision
  organisations"*.
- **No `SECURITY DEFINER` function relies on the caller's `search_path`** — the
  classic escalation against definer functions.
- **The audit trail has no UPDATE or DELETE policy.** It can only be added to.
- **The two private storage buckets are private:** `application-documents`
  (identity documents) and `work-order-media` (photographs taken inside client
  properties). `org-logos` is public by design — it paints an anonymous
  sign-in page.

### ⚠️ A false alarm worth recording

The first version of this check read the **grant** tables
(`information_schema.role_table_grants`, `has_function_privilege('anon', …)`)
and reported:

> ANON CAN WRITE: *(68 tables)* · ANON MAY EXECUTE 237 UNEXPECTED FUNCTIONS ·
> audit_log is mutable by anon

**Every one of those was wrong**, and publishing that verdict in a go-live
report would have been worse than publishing nothing. The grant layer is the
wrong thing to measure on Supabase: `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
TABLES TO anon, authenticated` is the platform's standard posture, and **RLS is
the boundary that sits on top of it**. Of the 237 functions, 24 were triggers
(not callable), 194 were `SECURITY INVOKER` (so RLS applies to everything they
touch), and all 22 definer functions were either public application surfaces or
gated internally.

The check now does what an attacker would do — holds the anon key and tries.

**Residual, recorded as a note not a finding:** 67 tables carry the platform's
default anon write grant. RLS refuses them, proven above. Revoking the grants
as well is defence in depth and is worth doing at cutover on a fresh production
project, where it costs nothing; it is not a fix for an open door.

---

## 3. The application boundary

Existing suites, all green on this tree:

| Suite | Covers |
|---|---|
| `verify-rls-rest` | org isolation over the real REST API |
| `verify-access-matrix`, `verify-permissions` | the B7 matrix, operator-governed |
| `verify-role-surface` | all ten roles: what each must and must not reach |
| `verify-payment-gate` | the B4 gate against direct API calls |
| `verify-remittance`, `verify-remittance-race` | nothing leaves twice |
| `verify-invoice-appeal` | who verifies/approves/remits, and the appeal path |
| `verify-oversight-roles` | executive authorises, finance disburses |
| `verify-operator-separation`, `verify-operator-governance` | the single audited cross-org crossing |
| `verify-function-grants` | every function reachable by exactly its declared roles |
| `verify-jwt-claims`, `verify-invitations`, `verify-invite-acceptance` | identity |
| `verify-rate-limit` | abuse controls — ⚠️ not run on PC2 this pass, see §6.4 |
| `verify-embeds` | every PostgREST join the app asks for resolves |

Two items surfaced on PC2's 9 August rerun of the full 80-suite `npm run
verify`, neither a security defect — detail and disposition in §6.5:

- `verify-action-errors` — **fixed**. A notification action silently
  discarded a database error; one form (`RequestResetForm.tsx`) discards its
  result deliberately, for anti-enumeration, and is accepted as-is.
- `verify-cross-org-dispatch` — **accepted, working as designed**. The
  isolation assertions all passed; the one failing sub-check is a test
  written before migration `0117_a_job_in_hand_has_a_hand.sql` added the
  "an assigned ticket needs an assignee" rule the test's unassign step now
  correctly gets refused by.

---

## 4. Dependencies

`npm audit` after applying every non-breaking fix: **0 critical, 7 high, 21
moderate.**

Two accepted risks, both requiring a board decision rather than a code change:

### 4a. `next@14.2.35` — fix requires a major upgrade to 16.x

Twenty-one advisories. **This is the significant one, and it is not being
silently accepted** — the recommendation is a deliberate deferral:

- A Next 14 → 16 upgrade is two major versions, touching routing, caching and
  Server Actions. Doing it days before go-live trades a set of largely
  non-applicable advisories for a large, untested regression surface across a
  system that moves client money.
- **Applicability was assessed, not assumed:**
  - The Image Optimizer advisories name **self-hosted** deployments; this runs
    on Vercel, and no `images.remotePatterns` is configured at all.
  - The Pages Router / i18n middleware bypass needs both; this is App Router
    with no i18n.
  - The custom-server SSRF needs a custom server; there isn't one.
  - The CSP-nonce XSS needs nonces; none are used.
  - What **does** apply is the Server Components DoS class (CVSS 7.5) and RSC
    cache poisoning (5.4) — availability and cache-correctness issues, not
    data disclosure. Vercel mitigates several at the edge.
- **Recommendation:** schedule the Next 16 upgrade as the first post-go-live
  work item, with its own regression cycle. Do not attempt it inside the
  cutover window.

### 4b. `@sentry/nextjs` — fix requires a major upgrade

Same shape, smaller blast radius. Error tracking, not a request path. Upgrade
alongside Next 16.

The remaining moderates are OpenTelemetry transitives pulled in by Sentry and
resolve with it.

---

## 5. Secrets

- `.env.local` is git-ignored and has never been committed (`git log --all
  --full-history -- .env.local` is empty).
- No API key, token or password is hardcoded anywhere in `app/`, `lib/`,
  `components/` or `scripts/` — every credential is read from `process.env`.
- The seeded demo password (`OEGroupDemo2026!`) appears in `scripts/` by
  design: it is a fixture for synthetic accounts on a synthetic database.
  **It must never exist in production**, which the clean-data gate already
  guarantees — production is migrated, never seeded.
- `SUPABASE_SERVICE_ROLE_KEY` is used only in server-side code and scripts,
  never in a client component.

---

## 6. Penetration test & load test — 9 August 2026

Run from PC2 against `https://oe-group-ipms-dev.vercel.app`, following
`security/README.md` steps 1–7. Step 8 (active scan) and step 9 (external
test) were not run — step 8 needs empty production (§7), step 9 needs a
third party and written authorisation.

Two bugs in the test tooling itself blocked this pass initially and are now
fixed, ahead of any application findings:

- `security/zap/automation-baseline.yaml` and `automation-full.yaml` used
  double-quoted YAML strings containing `\.` and `\Q…\E` — not valid YAML
  escapes, so both ZAP plans failed to parse before a scan could even start.
  Fixed by single-quoting those lines (YAML single quotes don't interpret
  backslashes). Neither file had ever been run before this pass, which is why
  this hadn't been caught.
- `security/k6/journey.js` didn't set an expected-status callback, so k6's
  default classifier counted the script's own intentional 404/401 checks
  (unknown org must 404; protected routes must refuse anonymously) as
  request failures. This tripped the `http_req_failed<2%` threshold on every
  run — exactly 1 in 8 requests, matching one guaranteed negative-test hit
  per iteration — regardless of the app's actual health. Fixed with
  `http.setResponseCallback(http.expectedStatuses(200, 302, 307, 401, 404))`.

### 6.1 ZAP baseline (passive)

0 High, 3 Medium, 4 Low, 4 Informational, against 123 crawled URLs (spider +
AJAX spider), unauthenticated.

| Finding | Risk | Decision |
|---|---|---|
| CSP header not set | Medium | **Deferred.** Adding a CSP without testing risks breaking Paystack checkout, the Sentry tunnel, or the chat webhooks — `DAY12_SECURITY_PASS.md` §4a already recorded that no CSP nonces exist. Owner: whoever does the Next 16 upgrade; do it together with real testing, not as a Day 12 drive-by. |
| Missing anti-clickjacking header | Medium | **Fixed.** Added `X-Frame-Options: DENY` site-wide in `next.config.mjs`. No iframe usage anywhere in the app, so no regression risk. |
| Cross-Domain Misconfiguration (`Access-Control-Allow-Origin: *`) | Medium | **Accepted, with a follow-up.** Confirmed live only on statically-generated public pages (e.g. `/reset-password`) — Vercel's standard behaviour for static HTML, not app config; nothing in the repo sets it. Since real financial/tenant data lives behind dynamic, authenticated routes and this scan was unauthenticated, the header's reach on those routes is unconfirmed. **Verify with an authenticated session before go-live.** |
| `X-Powered-By` header | Low | Skipped — documented false positive, `security/README.md` §4 ("Vercel's, not ours"). |
| Big Redirect Detected (`/` → `/orgs`, 4.8 KB body) | Low | **Accepted, confirmed benign.** Fetched and read the body: it's Next.js's standard `__next_error__` hydration shell (script tags, no page data), just larger than ZAP's redirect-size heuristic expects. No sensitive content. |
| Strict-Transport-Security not set (1 instance, `/reset-password`) | Low | **Accepted, with a note.** A direct `curl` to the same path returned `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — Vercel appears to add it inconsistently on the `.vercel.app` domain (cache-state dependent). **Verify directly against the production custom domain at cutover**, since that's what actually matters. |
| X-Content-Type-Options missing (systemic) | Low | **Fixed.** Added `X-Content-Type-Options: nosniff` alongside the clickjacking fix. |
| "Sensitive Information in URL" / credit-card-shaped value, on `/monitoring?o=…&p=…&r=…` | Informational | **False positive, confirmed.** `/monitoring` is Sentry's `tunnelRoute` (`next.config.mjs`) carrying Sentry org/project/region IDs, not payment data — ZAP's heuristic just Luhn-matched a numeric ID. **Worth adding to `security/README.md` §4's false-positive list** so future runs don't re-litigate it. |
| Modern Web Application / Re-examine Cache-Control / Retrieved from Cache | Informational | No action — observational only. |

### 6.2 k6 weekday journey profile

Clean after the script fix: **9,192 requests, p(95) 791 ms** (threshold
2,500 ms), **0.00% failed, 0.00% rate-limited.** Anonymous access to
`/dashboard`, `/dashboard/payments`, `/dashboard/ledger` and `/orgs` was
refused on every request throughout the run — the load test doubles as a
cheap, continuous access-control assertion, and it held.

### 6.3 k6 spike profile

**Pass, both thresholds green.** Ramped from 5 to 150 requests/second over
20 seconds, held at 150 rps for 60 seconds, against `/login`.

- `server_error_5xx`: **0.00%** — required to be exactly zero, and was.
- `http_req_duration{expected_response:true}` p(99): **1.36 s** (threshold
  8 s).
- 100% of checks passed (25,678/25,678); the sign-in page never went dark
  under a 30× burst.

### 6.4 The rate limiter

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` were not in PC2's
`.env.local` at first. Getting them there surfaced two separate, unrelated
things worth recording — one about credential handling, one a real test bug.

**Credential handling.** The keys exist, but only in Vercel's
**Production**-scoped environment variables for `oe-group-ipms-dev` — not
Preview, not Development. `lib/rate-limit.ts` **fails open by design**: "if
Upstash isn't configured... requests are ALLOWED." Right call for
availability, but it means any Preview/branch deployment of this project
currently has **no enforced rate limiting**. `vercel env pull` could not be
used to get the values onto PC2 — something on the machine (not Vercel, not
this AI session specifically) intercepts that CLI's writes and replaces
every value with a placeholder on disk, confirmed independently in a plain
text editor. The values had to be copied by hand from Upstash's own
dashboard instead (Vercel's "Sensitive" vars, once set, can't be revealed
again even by an owner). **Decision needed:** accept that Preview
deployments run unprotected, or provision Upstash for Preview too before
go-live.

**With real credentials in place, `verify-rate-limit.mjs` passes cleanly**
against live dev Redis: the first 5 requests from one sender are allowed,
the 6th+ are cut off; a different sender is unaffected by the first's
block; an unconfigured limiter fails open as designed; the shipped limits
(5/10s per sender, 100/10s per IP) both hold. **The limiter itself works.**

**`npm run loadtest:ratelimit` (the k6 version) does not exercise it at
all, and its threshold failure is misleading.** It POSTs plain JSON to
`/reset-password`, but that page's real endpoint is a Next.js **Server
Action** — a POST distinguished by a build-specific `Next-Action` header
and an encoded-args body, not a REST call. Confirmed with a bare `curl
-X POST`: **405 Method Not Allowed**, before the request ever reaches
`requestPasswordReset` or the limiter inside it. That's why `requests_refused`
was 0 after 1,187 requests (the code path never ran) and `http_req_failed`
was 100% (405 counts as failed) — both numbers are consistent with "every
request bounced off routing," not "the limiter is absent."

**Not fixed live**, because the real fix — either replicating the
Next-Action invocation protocol (fragile: the digest is build-specific and
would need re-extracting on every deploy) or retargeting the script at a
genuinely REST-shaped rate-limited endpoint (`app/api/webhooks/{telegram,
whatsapp,email/resend,payments/[gateway]}/route.ts` are real route handlers,
unlike `/reset-password`) — needs someone who knows which of those webhook
paths is safe to hammer with synthetic payloads and picks appropriately.
`security/k6/rate-limit.js` needs a rewrite before it's trustworthy; until
then, `verify-rate-limit.mjs` is the authoritative check for this control.

### 6.5 Application-boundary items from the 9 August full re-run

`npm run verify` was re-run in full on PC2 (interrupted once by a machine
restart mid-run; the completed re-run is what's recorded here). 76 of 80
suites passed outright; 4 needed a closer look:

- `verify-checkout-e2e`, `verify-intake-intelligence` — **not real
  failures.** Both need `npm run dev` serving `localhost:3000`, which
  wasn't running for the first pass. Both pass cleanly once it is.
- `verify-action-errors` — **2 checks, both addressed:**
  - `app/dashboard/settings/notifications/actions.ts` (new, from the
    notification-inbox feature) didn't use this app's `ActionResult`
    convention, and silently discarded the Supabase error from
    `markAllNotificationsRead`. **Fixed** — converted to `ActionResult`,
    and `NotificationInbox.tsx` now surfaces a failure via
    `runAction`/toast instead of pretending it worked.
  - `RequestResetForm.tsx` discards `requestPasswordReset`'s result too —
    but that's deliberate: the component's own comment explains the action
    always reports success to the caller, for the same anti-enumeration
    reason the sign-in form uses. **Accepted, as designed**, not touched.
- `verify-cross-org-dispatch` — **1 check, accepted as working correctly.**
  Every actual cross-org isolation assertion passed. The one failure is the
  test's own "a ticket can still be unassigned" step, refused by the DB rule
  added in `0117_a_job_in_hand_has_a_hand.sql` ("an assigned ticket needs an
  assignee"). The constraint is doing exactly what that migration intended;
  the test predates it and needs updating to dispatch elsewhere rather than
  clear to null — a test-maintenance item, not a security finding.

None of the four touch access control, the payment gate, or org isolation.

**Six items from this pass need further work and are written up as
self-contained, actionable tasks in `docs/DAY12_FOLLOWUPS.md`** — the k6
rate-limit script rewrite, the CSP header, verifying the CORS/HSTS findings
against authenticated routes and the real custom domains, the stale
cross-org-dispatch test, and the Preview-environment rate-limiting decision.

### 6.6 Closeout — all six follow-ups resolved, 9 August 2026 (PC1)

Worked through on PC1 the same day. **Four fixed in code, two closed by
measurement; evidence for each is in `docs/DAY12_CLOSEOUT.md` §2.** Three
findings above are amended by what that work turned up, and the amendments
matter more than the fixes:

- **CSP (§6.1) — the reason for deferring did not hold.** "Adding a CSP risks
  breaking Paystack checkout" is not true: checkout is a top-level navigation
  (`window.location.href`) to Paystack's hosted page, and CSP does not restrict
  navigating away. A **report-only** policy now ships site-wide. Promoting it to
  enforcing still waits on nonces, with the Next 16 upgrade.
- **CORS (§6.1) — closed, confirmed safe by measurement rather than inference.**
  With a real session, `Access-Control-Allow-Origin` is absent from
  `/dashboard`, `/dashboard/payments` and `/dashboard/settings/notifications`.
  It appears only on statically-generated, edge-cached responses.
- **HSTS (§6.1) — this one was a real gap, not just an inconsistency.** Both
  custom domains served a bare `max-age=63072000` with **no
  `includeSubDomains`**, while `.vercel.app` served the full directive. Now set
  explicitly in `next.config.mjs` so it is identical on every domain. `preload`
  is deliberately not sent.
- **The rate limiter (§6.4) is now proven end to end over HTTP**, not only
  directly: 978 of 1,191 requests refused from one source in 30 s, which also
  independently confirms the configured 100-per-10-s per-IP limit is the limit
  actually running.
- **Preview rate limiting (§6.4) — the decision is easier than it looked.**
  Vercel Deployment Protection refuses every deployment-specific URL
  anonymously (302 to SSO; 401 on the webhook) *before the application runs*, so
  there is no anonymous surface for the absent limiter to fail to protect.
- **Both application-boundary items (§6.5) are now fixed rather than accepted**,
  and `npm run verify` is green — so no permanently-red check remains to train
  people into reading failures as normal. `verify-action-errors` turned out to
  hide a real bug beneath the deliberate anti-enumeration silence.

⚠️ **The four header fixes are in the repository, not yet on the deployment.**
A ZAP baseline run against the current dev host still shows the pre-fix state.
Re-scan after this branch deploys.

---

## 7. What this pass does NOT cover

Stated plainly, because a security report that implies more coverage than it has
is itself a risk.

- **No external penetration test.** An external test needs a third party plus
  written authorisation from OE Group; neither exists yet.
- **No active (full) ZAP scan.** `security/zap/automation-full.yaml` is
  configured and its exclusions verified sane, but the pre-flight in
  `scripts/pentest-preflight.mjs` only clears an active scan against a
  target with no remittance ever sent and no live payment-gateway key — i.e.
  empty production, which doesn't exist yet. Running it against dev would
  either be refused (correctly) or, if forced, risk replaying a real
  Server Action.
- **No working k6 rate-limit check.** `verify-rate-limit.mjs` covers the
  limiter directly and passed; `loadtest:ratelimit` needs a rewrite before
  it proves anything — see §6.4.
- **No review of the hosting providers' own posture** — Supabase, Vercel,
  Paystack, 360dialog. That is covered contractually by the DPAs in
  `NDPA_COMPLIANCE_PACK.md` §4, not technically by us.
- **Nothing about physical or personnel security** at OE Group.

---

## 8. Re-running this at cutover

```bash
npm run verify
node scripts/verify-security-posture.mjs
npm run pentest:baseline -- https://your-production-host
npm run loadtest -- https://your-production-host
npm run loadtest:spike -- https://your-production-host
npm run loadtest:ratelimit -- https://your-production-host
```

All six take their target/credentials from the environment. Point them at
production, confirm the same results, and record the run date here.
`pentest:full` (the active scan) only runs in the window `GO_LIVE_CHECKLIST.md`
describes — production started, empty, before the first real org onboards —
and only after the Rules of Engagement in `security/README.md` §5 are filled
in and `ZAP_USER`/`ZAP_PASSWORD` point at a throwaway low-privilege tenant.
