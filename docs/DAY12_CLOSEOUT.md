# Day 12 — security pass closeout, and what is still open

**Written on PC1, 9 August 2026**, continuing directly from PC2's pentest and
load-test pass (`docs/DAY12_SECURITY_PASS.md` §6) and working through the six
items PC2 handed over in `docs/DAY12_FOLLOWUPS.md`.

This is the **single document to open when asking "what is left before we go
live?"** It is written so either machine can act on any line without reading
the other two documents first. Where an item belongs to a person rather than a
machine, it says so and says who.

**Three documents, three jobs — don't merge them:**

| Document | Answers |
|---|---|
| `DAY12_SECURITY_PASS.md` | *What did we test, and what did it find?* — the report |
| `DAY12_FOLLOWUPS.md` | *What did that pass leave undone?* — PC2's handover, now fully dispositioned below |
| **this file** | *What is still open, who owns it, and when does it have to happen?* |

`GO_LIVE_CHECKLIST.md` (reference) and `GO_LIVE_RUNWAY.md` (sequence) remain
the authority on cutover itself. This file feeds them; it does not replace
them.

---

## 1. Verdict

**All six of PC2's follow-ups are closed** — four fixed in code, two closed by
measurement. Four further items were found on this pass and are recorded in §3.

**No blocking technical defect exists.** Nothing found on either day touched
access control, org isolation, the payment gate, or the audit trail. What
remains before go-live is almost entirely **other people's paperwork and
accounts** (§5), not code.

| | 8 Aug (PC1) | 9 Aug (PC2) | 9 Aug (PC1, this pass) |
|---|---|---|---|
| Database boundary | ✅ 30 checks | — | ✅ re-run, still clean |
| Application boundary | ✅ ~600 checks | ⚠️ 2 items | ✅ **both items fixed** — see the note below |
| ZAP baseline | — | ✅ 0 High, 3 Medium | headers fixed, **needs a re-scan after deploy** |
| k6 journey + spike | — | ✅ both pass | — |
| k6 rate-limit | — | ⛔ script broken | ✅ **rewritten and proven** |
| Secret scan | ✅ 4 false positives | — | ✅ **now a clean exit** (`.gitleaksignore`) |
| Dependencies | ⚠️ 7 high, 21 moderate | — | unchanged — deliberate deferral, §7 |
| ZAP active scan | ⛔ needs empty production | ⛔ same | ⛔ same — §6 |
| External pen test | ⛔ needs a third party | ⛔ same | ⛔ same — §5 |

> **On "80/80", stated precisely.** The full 80-suite run that opened this pass
> reported exactly two failures — `verify-action-errors` and
> `verify-checkout-e2e` — and both are fixed (§3.1, §3.2). Each now passes when
> run on its own; `verify-checkout-e2e` was re-run three times to be sure.
>
> **The confirming re-run was destroyed by the machine's network, not by the
> code — and the diagnosis matters more than the result.** It ended reporting
> 19 of 80 suites failed. Reading the actual errors rather than the count:
> `getaddrinfo ENOTFOUND aws-1-eu-west-2.pooler.supabase.com`, `fetch failed`,
> and a cascade of `Cannot read properties of null` — which is what every suite
> does when its fixture query silently returns nothing. **DNS on this machine
> dropped part-way through.** The same outage killed three Vercel deploy
> attempts in the same window (§10).
>
> **All 19 were re-run individually once the network returned. Every one
> passes**, including `verify-role-surface` (which had only timed out at 300 s)
> and `verify-checkout-e2e`.
>
> ⚠️ **The lesson is about reading these runs, not about the run.** A count of
> failures is not a result. Nineteen red suites here meant one broken network;
> two red suites in the earlier run meant two real defects. `verify-all.mjs`
> reports only counts, so **always read the error text before concluding
> anything** — and re-run a failing suite on its own before believing or
> dismissing it.
>
> The earlier `verify-checkout-e2e` single-check failure (71 s against a 23 s
> baseline) is now most likely the leading edge of that same network
> instability, rather than the slow-route-compilation hypothesis first recorded
> here. It has since passed five isolated runs. **Still worth watching**: it is
> a payment suite, and an intermittent failure there should never be waved
> through on the strength of this paragraph.

---

## 2. PC2's six follow-ups — all closed

### #1 — `security/k6/rate-limit.js` rewritten ✅ FIXED

PC2 found it was POSTing plain JSON at `/reset-password`, whose handler is a
Server Action, so every request bounced off routing with a 405 and
`requests_refused` was always 0.

**It had a second bug underneath that one**, which would have survived a naive
retarget: it asserted **HTTP 429**, and *nothing in this application ever
sends 429*. Every rate-limited route is deliberately quiet under abuse — the
intake webhooks answer `200 "OK"` when the coarse per-IP gate trips (so
Telegram/Meta/the payment gateways don't retry-storm a flood), and
`/reset-password`'s own gate returns the same `ok()` as success, on purpose,
so a prober cannot learn that an address was tried recently.

Retargeted at `app/api/webhooks/telegram/route.ts` — a real route handler that
calls `checkRateLimit()` on every POST. A probe with no secret token is
refused either way, and *which* refusal it gets is the signal:

- under the limit → **403** (unknown Telegram secret token)
- over the limit → **200 `"OK"`** (the per-IP gate drops it before the token
  check runs)

The script now asserts that flip. **Proven against dev**, twice:

```
requests_rate_limited ......... 978    ✓ 'count>0'
requests_signature_rejected ... 213
http_req_failed ............... 0.00%
checks .......................  100.00% (1191/1191) — no 5xx under abuse
```

213 allowed out of 1,191 over 30 s matches `INTAKE_LIMITS.coarsePerIp`
(100 per 10 s) almost exactly — an independent confirmation the configured
limit is the limit actually running.

> Also fixed the same `http.setResponseCallback` trap PC2 fixed in
> `journey.js`: without it the deliberate 403s counted as request failures and
> the run reported `http_req_failed: 22%` on a perfectly healthy system.

### #2 — Content-Security-Policy ✅ SHIPPED, report-only

Now set site-wide in `next.config.mjs` as **`Content-Security-Policy-Report-Only`**.
A report-only header cannot block anything — the browser evaluates it, reports
what *would* have been refused, and serves the page regardless. Safe to have
live on a system that moves client money, and the only way to learn what a real
policy breaks before it breaks it.

**The reason it was deferred turns out not to hold.** PC2 recorded "a CSP
without testing risks breaking Paystack checkout". Checkout is a **top-level
navigation** — `window.location.href = checkoutUrl` in `RentCharges.tsx` — to
Paystack's own hosted page. CSP governs subresources, frames and form posts; it
does not restrict navigating away. **Paystack needs no allowlist entry at all**,
and nothing it serves is ever loaded into this origin.

Enumerated rather than guessed, the browser's only external loads are:

| Origin | Why | Directive |
|---|---|---|
| `challenges.cloudflare.com` | Turnstile — the app's only third-party `<script>`, plus its iframe | `script-src`, `frame-src`, `connect-src` |
| the Supabase project | REST, storage, realtime (`wss:`) | `connect-src`, `img-src` |
| *(Sentry)* | **not external** — `tunnelRoute: "/monitoring"` keeps it same-origin | covered by `'self'` |

Fonts are `next/font/local`; there is no font CDN, no analytics, no other CDN.

**Verified**: production build served locally, `/login`, `/o/tfml` and the
public application page each load with **zero CSP violations in the console**.
Authenticated pages (`/dashboard`, `/dashboard/payments`,
`/dashboard/ledger/collections`) contain **no absolute external URL in their
markup at all** — checked with a real session.

⚠️ **`'unsafe-inline'` in `script-src` is load-bearing, not laziness.** Next 14's
App Router emits inline hydration and flight-data scripts on every page and
this app uses no CSP nonces. Removing it means adopting nonces app-wide — real
work, correctly sequenced with the Next 16 upgrade (§7), not a cutover-week
edit. The directives that bite *without* nonces are still worth having on their
own: `frame-ancestors`, `object-src 'none'`, `base-uri` and `form-action` each
close a real class of attack.

**Promoting it to enforcing is §7.** Do not do it in the cutover window.

> `upgrade-insecure-requests` is deliberately absent: browsers ignore it in a
> report-only policy and log an error saying so, which would put a permanent
> meaningless error in every console — corrosive when the whole plan for this
> header is "run UAT and have testers report console errors."

### #3 — CORS wildcard ✅ CLOSED, measured, confirmed safe

PC2 could not test this because the ZAP scan was unauthenticated. Measured
directly, with a real session on a low-privilege account:

| Route | Response | `Access-Control-Allow-Origin` |
|---|---|---|
| `/reset-password` | 200, `X-Vercel-Cache: PRERENDER` | **`*` present** |
| `/dashboard` | 200, `Cache-Control: private, no-cache` | **absent** |
| `/dashboard/payments` | 200, private | **absent** |
| `/dashboard/settings/notifications` | 200, private | **absent** |
| `/login`, `/o/[slug]` | 200, dynamic | **absent** |

The header appears **only** on statically-generated, edge-cached responses —
Vercel's standard behaviour for static HTML, nothing in this repository sets it.
Every dynamic, per-request, session-scoped response lacks it entirely.

**Disposition: closed, no action.** `ACAO: *` on a page with no session and no
data is not a finding.

### #4 — HSTS ✅ FIXED — and the check found a real gap

PC2 saw an inconsistency on `.vercel.app` and asked for a check against the
custom domains. That check found something: **the two domains real users
actually hit carried a weaker HSTS than the deployment URL.**

```
oe-group-ipms-dev.vercel.app   max-age=63072000; includeSubDomains; preload
tfmlportal.com                 max-age=63072000
oeaportal.com                  max-age=63072000
```

Without `includeSubDomains` the apex is protected but `anything.tfmlportal.com`
is not — and a subdomain reached over plain HTTP can set a cookie scoped to the
parent domain, which is the session-fixation shape HSTS exists to close.

**Fixed by setting the header in `next.config.mjs`**, so it is ours rather than
the platform's and is identical on every domain, present and future. Checked
before adding `includeSubDomains`: neither apex publishes any web subdomain
(only `oeaportal.com`'s registrar MX records, which HSTS does not touch), so
nothing breaks.

⚠️ **`preload` is deliberately NOT sent.** The token does nothing until the
domain is submitted to hstspreload.org, and that submission **is a one-way
door** — removal from the browsers' built-in lists takes months. See §7.

### #5 — `verify-cross-org-dispatch` ✅ FIXED, suite green

The failing step tried to clear `assigned_to_user_id` to `null` while leaving
`status: 'assigned'`, and asserted that succeeds. It is refused by
`tickets_require_an_assignee()` (migration `0117`) — correctly.

Confirmed against 0117's stated intent before changing the assertion's meaning,
as PC2 asked: the product has **no bare-unassign path at all**.
`assignTicket()` refuses with *"Pick a vendor or an ops person to assign this
to"*, and 0117's own comment records that the UI's manual status list no longer
offers `assigned` precisely because a dropdown that silently un-assigns a job is
a trap.

So the step now tests what the application actually permits — **re-dispatch to
a different assignee** — rather than a state the system was deliberately built
to refuse. All 7 checks pass.

### #6 — Rate limiting on Preview deployments ✅ RECOMMEND ACCEPT — the exposure is nil

PC2 framed this as a decision between "accept it" and "provision Upstash on
Preview". **Measurement changes the framing: there is nothing reachable to
rate-limit.** Vercel Deployment Protection is enabled on this project, and every
deployment-specific URL refuses anonymously *before the application runs*:

```
GET  /login                     → 302  https://vercel.com/sso-api?…
POST /api/webhooks/telegram     → 401
```

Confirmed against both a Preview and a per-deployment Production URL. The
production **alias** and the custom domains are unaffected and serve publicly,
as they must — that is the standard Vercel split.

**Recommendation: accept as-is (option a).** A Preview deployment has no
anonymous attack surface for an absent limiter to fail to protect. Provisioning
Upstash on Preview is optional hygiene, not a security requirement, and it costs
a shared Redis quota against branch deploys.

> ⚠️ **Consequence worth carrying into the cutover run:** none of the ZAP or k6
> tooling can ever be pointed at a deployment-specific URL — it would measure
> Vercel's SSO wall, not this application. Always target the **alias** or a
> custom domain. Two of the numbers in this report would have been meaningless
> otherwise.

---

## 3. Found on this pass — four items PC2's pass could not have seen

### 3.1 `verify-action-errors` — a real discarded-error bug ✅ FIXED

PC2 accepted this one as "deliberate, anti-enumeration, not touched". That is
right about `requestPasswordReset`'s *silence on account existence* — which
must stay — but there is a second branch underneath it that is a genuine bug.

`requestPasswordReset` also returns `fail("Enter a valid email address.")` for a
malformed address, and `RequestResetForm` carries **`noValidate`**, so the
browser does not catch it first. The string reached the action, came back a
failure, was discarded, and the form showed *"Check your email"* for an address
no email could ever be sent to.

Fixed by checking the result and surfacing that one message inline. Nothing
leaks: the input is wrong on its face, independently of who has an account. All
other paths — sent, unknown, stranded-shell, rate-limited — still return an
identical `ok()`.

**This matters beyond the bug**: the suite is now green, so `npm run verify` has
no permanently-red check training people to read failures as normal.

### 3.2 `verify-checkout-e2e` cannot run against production — by design ⚠️ RECORD, don't "fix"

PC2 recorded these 10 failures as "not real — needs `npm run dev`". True, but
the reason is sharper and has a consequence for cutover.

This suite drives the **simulated** gateway, and
`getAdapterByName("simulated")` refuses to exist wherever real money is
possible. Two things switch it off:

- `NODE_ENV=production` — **which `npm start` sets, even on localhost**;
- any `PAYSTACK_SECRET_KEY` or `FLUTTERWAVE_SECRET_KEY` in the environment.

The route then answers a bare `403`, identical to a bad-signature refusal
(deliberately — distinguishing them would hint at internal state), so it
surfaced as ten unexplained *"got 403"* lines. That cost an hour here.

⚠️ **So `verify-checkout-e2e` can never be part of the production cutover run**
— and `GO_LIVE_CHECKLIST.md` §1 says *"Run `npm run verify` against production
credentials before declaring it live."* Taken literally that will report 10
false failures at the worst possible moment. The real gateway path is covered by
`verify-collections` and `verify-payment-gate`, which do run there.

**Fixed the diagnostics, not the control:** the suite now pre-flights by sending
a *correctly signed* notification for a nonexistent reference — which the route
accepts harmlessly if the adapter exists — and exits with a plain explanation if
it does not. Verified in both directions (passes on `npm run dev`; explains
itself against the deployed host).

**All 21 checks pass** under `npm run dev`.

### 3.3 Turnstile is not in the go-live environment table ⚠️ OPEN — needs a decision

`GO_LIVE_CHECKLIST.md` §2 enumerates every production environment variable.
**`TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are not in it**,
and are set on no environment today.

The public vendor-application form defends itself in layers — per-IP rate limit
→ honeypot → submission timing → **Turnstile** — and `lib/turnstile.ts` no-ops
cleanly when unconfigured. So the last layer is silently off, on what is one of
the very few anonymous write surfaces in the system.

**Decision needed (OE Group):** in or out for go-live. Out is a perfectly good
answer — three layers remain — but it should be a decision, not a discovery.
If in, it is a free Cloudflare product and a five-minute setup. **Either way,
add both variables to `GO_LIVE_CHECKLIST.md` §2 so the next person doesn't
re-find this.**

### 3.4 Secret scanning now exits clean ✅ FIXED

`gitleaks detect` reported the same 4 findings on PC1 as PC2 saw, all confirmed
false positives (two invented `FLWSECK-` key *shapes* used to prove
`gatewayMode()` reads the prefix; two `key:` form-field names next to human
labels). It also exited **non-zero every time**, which trains whoever runs it to
read *"leaks found: 4"* as normal — exactly how a fifth, real one gets waved
through.

Added `.gitleaksignore` with all four pinned by fingerprint **and the reason
each is not a credential**. Fingerprints include the introducing commit, so
editing those files later does not silently keep the exemption alive.

`gitleaks detect` now exits **0, "no leaks found"** — so it can go into CI, and
a real leak is visible as a change of state rather than a change of count.

---

## 4. Still open before go-live — PC1 / PC2

Ordered by what blocks what. None of these is a defect; they are steps.

| # | Item | Owner | Notes |
|---|---|---|---|
| 4.1 | ~~Deploy this branch~~ ✅ **DONE 10 Aug** — **re-run the ZAP baseline** | PC2 (needs Docker) | Deployed to production and verified live on both custom domains: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`, and the report-only CSP. Load test against the live deployment: 7,912 requests, p(95) 1,014 ms, **0.00% failed**; rate limiter confirmed live (908 refused of 1,163). **What remains is the ZAP re-scan** — the two header findings should now be gone. See §10 for how the deploy actually had to be done. |
| 4.2 | **Watch the CSP report-only console during UAT** | both | This is the whole point of shipping it report-only. Brief UAT testers to report console errors. A clean console across all nine roles is what unlocks §7's promotion to enforcing. |
| 4.3 | **Install Docker Desktop on PC1** | PC1 | `security/README.md` says either machine can run the pass; today only **PC2 can** — PC1 has no Docker, so no ZAP. Single-machine dependency on the one tool the cutover run needs. k6 and gitleaks are now installed on PC1 (k6 v2.1.0). |
| 4.4 | **Fill in the Rules of Engagement** — `security/README.md` §5 | PC1/PC2 + a named authoriser | Still an empty table: authoriser, target hostnames, window, contact, abort condition. **Required before the active scan (§6) and before any third-party test.** Cannot be filled in without §5.9. |
| 4.5 | **Correct `GO_LIVE_CHECKLIST.md` §1** so the cutover run excludes `verify-checkout-e2e` | either PC | Per §3.2. Otherwise it reports 10 false failures during cutover. |
| 4.6 | **Add the Turnstile variables to `GO_LIVE_CHECKLIST.md` §2** | either PC | Per §3.3, whichever way the decision goes. |
| 4.7 | **Re-run everything against production** | either PC | The commands are in §8. This is the actual Day 12 deliverable — everything so far targets dev, and `DAY12_SECURITY_PASS.md`'s own banner says so. |

---

## 5. Still open before go-live — OE Group / the board

**These are the critical path.** Every one needs a person with authority
outside this codebase, and several are queues at someone else's end. They are
listed in full in `GO_LIVE_CHECKLIST.md` §1 and sequenced by lead time in
`GO_LIVE_RUNWAY.md` Stage 1 — repeated here only as the single "what is left"
list this document promises.

| # | Item | Lead time | Blocks |
|---|---|---|---|
| 5.1 | **Designate the DPO** — a named person, per NDPA | days (internal) | every DPA below |
| 5.2 | **Sign processor DPAs** — Supabase, Vercel, Anthropic, 360dialog, Paystack, Resend (+ Flutterwave, Telegram if offered) | weeks | real personal data flowing |
| 5.3 | **Publish the privacy notice**, incl. the automated document-verification line (decision 10) | days after 5.1 | first real applicant |
| 5.4 | **Paystack live keys** — business/KYC review | 1–3 weeks | real money |
| 5.5 | **Open the segregated client-funds bank account** | 1–4 weeks | daily reconciliation (decision 2) |
| 5.6 | **Provision a production Supabase project + production Vercel project** | account owner | *everything in §4.7* |
| 5.7 | **Confirm the 360dialog account tier** for both numbers | days | whether the dormant HMAC path ever goes live |
| 5.8 | **Create the two Telegram bots** in @BotFather — `TELEGRAM_BOT_SETUP.md` | 20 minutes | still not done as of today |
| 5.9 | **Authorise the security testing in writing** — name, role, date, target hostnames, window | days | §4.4, the active scan, and any third-party test |
| 5.10 | **Commission an external penetration test** — third party | weeks | nothing technical; it is the independent assurance the board will be asked for |
| 5.11 | **Board go/no-go** after UAT | — | cutover |

### Decisions that are cheap now and expensive late

- **Turnstile in or out** (§3.3) — new on this pass.
- **Flutterwave / FX in or out** — code is built and verified; a yes starts
  another KYC queue.
- **SMS fallback (`AFRICASTALKING_API_KEY`) in or out** — the B8 cascade logs
  `skipped` and carries on. Out is fine; undecided is not.
- **Gemini failover: enable billing, or accept best-effort.** The key is set
  and the code works, but the free tier's *daily* quota was exhausted on a key
  minutes old. Believing there is a failover because a key is present is the
  one unacceptable option.
- **The admin-fee shape** — open since Day 9.
- **HSTS preload submission** — see §7.

---

## 6. The cutover window only — the active ZAP scan

⛔ **Not run, and cannot be run yet.** This is not a gap in diligence; it is the
one test with a window.

`scripts/pentest-preflight.mjs` clears an active scan only against a target
with **no remittance ever sent and no live payment-gateway key** — i.e. empty
production, which does not exist. The pre-flight is wired into
`npm run pentest:full` and blocks the run; it is not advisory.

**The window is:** production migrated and started, **before the first real org
is onboarded**. `GO_LIVE_CHECKLIST.md` §1 guarantees production starts empty, so
that gap exists by construction. After it, the honest answer is a third-party
test against a staging clone (§5.10).

Before running it: §4.4's Rules of Engagement filled in, and `ZAP_USER` /
`ZAP_PASSWORD` pointing at a **throwaway low-privilege tenant that is
deactivated afterwards** — never a real person's account, because the scan
submits forms as them and their name ends up on the audit trail against
machine-generated input.

---

## 7. After go-live

| Item | Why it waits | Owner |
|---|---|---|
| **Next 14 → 16 upgrade, with its own regression cycle** | Two major versions across routing, caching and Server Actions. `DAY12_SECURITY_PASS.md` §4a assessed each advisory rather than waving them through: what applies is the Server Components DoS class and RSC cache poisoning — availability and cache-correctness, not data disclosure. Doing this in the cutover window trades largely non-applicable advisories for a large untested regression surface on a system that moves client money. **First post-go-live work item.** | PC1/PC2 |
| **`@sentry/nextjs` major upgrade** | Same shape, smaller blast radius — error tracking, not a request path. The remaining moderate advisories are OpenTelemetry transitives that resolve with it. | with the above |
| **Promote CSP from report-only to enforcing** | Needs (a) a clean console across all nine roles during UAT, and (b) CSP nonces to drop `'unsafe-inline'`, which belongs with the Next 16 upgrade. | with the above |
| **Decide on HSTS `preload`** | A genuine one-way door: submission to hstspreload.org takes months to undo. `includeSubDomains` is already live and is the part that closes the actual attack. | OE Group |
| **Revoke the platform's default `anon` write grants** | 67 tables carry Supabase's standard `ALTER DEFAULT PRIVILEGES` grant. **RLS refuses them — proven by holding the anon key and trying, 30 checks.** This is defence in depth, not a fix for an open door, and it costs nothing on a fresh production project where no application depends on the grants yet. | PC1/PC2, at or just after cutover |
| **Third-party penetration test** against a staging clone | Once production holds client data, §6's window has closed. | OE Group (§5.10) |
| **Role-based user guides** (nine roles + a combined admin/onboarding guide) | Must be written against the final production screens so a guide never describes a button that moved. Plan is in `GO_LIVE_CHECKLIST.md` §3. **The admin/onboarding guide needs to exist before a second org is ever provisioned for real.** | PC1/PC2 |
| **Daily bank reconciliation as an operational routine** | Locked decision 2, and the thing an auditor actually asks to see. A screen that exists is not a routine that runs. | OE Group |
| **Wire `gitleaks` and `verify-security-posture` into CI** | Both now exit clean, so both can gate a merge rather than being remembered. | PC1/PC2 |

---

## 8. Re-running all of this — the exact commands

Every one takes its target and credentials from the environment, so pointing
them at production is a matter of credentials, not code.

**Order matters — each step gates the next** (`security/README.md` §3).

```bash
node scripts/verify-security-posture.mjs
```

```bash
npm run verify
```

```bash
npm audit
```

```bash
gitleaks detect --no-banner --redact
```

```bash
npm run pentest:baseline -- https://your-production-host
```

```bash
npm run loadtest -- https://your-production-host
```

```bash
npm run loadtest:spike -- https://your-production-host
```

```bash
npm run loadtest:ratelimit -- https://your-production-host
```

Then, and **only** inside the §6 window, on empty production:

```bash
npm run pentest:full -- https://your-production-host
```

### Four things that will otherwise waste an hour

1. **Never point any of this at a deployment-specific URL** (`…-abc123-….vercel.app`).
   Deployment Protection answers 302/401 before the app runs, so you measure
   Vercel's SSO wall. Use the alias or a custom domain. (§2.#6)
2. **`verify-checkout-e2e` needs `npm run dev`, and must be excluded from the
   production run** — `npm start` sets `NODE_ENV=production`, which correctly
   disables the simulated gateway. The suite now says so itself. (§3.2)
3. **`npm run verify` needs a dev server on `localhost:3000`** for
   `verify-checkout-e2e` and `verify-intake-intelligence`; without one they
   fail for no real reason.
4. **ZAP needs Docker**, which today only PC2 has. (§4.3)

### What "green" looks like

- `verify-security-posture` — 30 checks, all pass
- `npm run verify` — **80 suites: 79 pass, 1 marked DEMO** (`verify-cascade`
  asserts nothing by design). Run it with as little else competing for the
  machine as possible: several suites take 1–4 minutes and at least one
  (`verify-checkout-e2e`) has shown a check failing under contention — see the
  note in §1.
- `gitleaks detect` — exit 0, *"no leaks found"*
- `npm audit` — 0 critical, 7 high, 21 moderate (the deliberate deferral, §7)
- `loadtest` — p(95) well under 2,500 ms, 0.00% failed, 0.00% rate-limited
- `loadtest:spike` — `server_error_5xx` exactly 0.00%
- `loadtest:ratelimit` — `requests_rate_limited` **> 0**, and roughly
  `100 × (duration ÷ 10 s)` requests allowed

---

## 9. Machine parity

`security/README.md` promises either machine can run the pass. Today that is
not quite true — recorded so it is fixed deliberately rather than discovered on
cutover day.

| Tool | PC1 | PC2 |
|---|---|---|
| Node + the 80 verification suites | ✅ | ✅ |
| k6 | ✅ v2.1.0 (installed this pass) | ✅ |
| gitleaks | ✅ (installed this pass) | ✅ |
| **Docker / ZAP** | ❌ **— §4.3** | ✅ |
| Upstash credentials in `.env.local` | ✅ | ✅ (hand-copied — see below) |

---

## 10. How to actually deploy to production — read this before cutover

Recorded because it took four attempts to establish, and **cutover is the worst
possible moment to discover it.**

### `git push` does not deploy production

`phase-1` is not the project's production branch (`main` is, and it is 191
commits behind and unused). A push produces a **Preview** deployment only. The
custom domains are served by a deployment with `target: production`, which has
to be created deliberately.

### ⛔ Never "promote" a Preview build to production

The obvious move — build from git, then promote — **would take the portals
down**, and silently. `vercel promote` does not rebuild, so the deployment keeps
the environment it was built with, and on this project **every Supabase
credential is Production-scoped only**:

```
NEXT_PUBLIC_SUPABASE_URL        Production
NEXT_PUBLIC_SUPABASE_ANON_KEY   Production
SUPABASE_SERVICE_ROLE_KEY       Production
ANTHROPIC_API_KEY, TELEGRAM_*, WHATSAPP_*, UPSTASH_*, SENTRY, GEMINI   Production
```

A promoted Preview build therefore has **no database at all**. It would also
have baked in the wrong CSP: `next.config.mjs` reads
`NEXT_PUBLIC_SUPABASE_URL` at build time, so an absent value silently degrades
the policy to the `https://*.supabase.co` wildcard. **Check for the real
project host in the deployed CSP header — it is a free, honest signal that a
build got the production environment.**

### ⚠️ `vercel --prod` fails on these machines

Tried three times, foreground and background: the CLI creates the deployment
record, prints "Building…", then dies with `Error: fetch failed`. The
deployments sit at status `UNKNOWN` with a 0 ms build — the local file upload
never completes. They never take the aliases, so **the live site is unharmed**,
but nothing deploys either.

This is the same class of fault PC2 already recorded for `vercel env pull`
(below): something on these machines interferes with that CLI's HTTPS calls.
It is not transient — it reproduced every time.

### ✅ What works: rebuild server-side from the git-built Preview

```bash
git push origin phase-1
```

Wait for Vercel's automatic Preview build, then:

```bash
npx vercel redeploy <the-preview-url> --target production --no-wait
```

This rebuilds **on Vercel**, so there is no local upload to fail, it builds
from the pushed commit (nothing uncommitted can ride along), and `--target
production` means it builds with **Production** environment variables — which
is exactly what promoting would not do.

> The CLI still printed `Error: fetch failed` — it loses the polling
> connection. **Ignore the exit status and check the real state** with
> `npx vercel ls`. The deployment was `● Ready / Production / 2m` and held all
> four aliases.

### Then verify, every time

```bash
curl -sSI https://tfmlportal.com/login
```

Confirm the four security headers are present, and that the CSP names the real
Supabase host rather than `*.supabase.co`. Then load a brand front door and
check it renders its own name from the database.

### One more trap, for the real cutover

Deploying from a working copy uploads **uncommitted files too**. On 10 Aug this
repository had an unrelated in-flight feature sitting uncommitted from a
parallel session; deploying from the working directory would have shipped it.
The route above avoids this by construction — Vercel builds from the commit —
which is a reason to prefer it beyond the CLI being broken.

---

## 11. Machine-specific traps

> ⚠️ **`vercel env pull` cannot be trusted on these machines.** PC2 found
> something local intercepts that CLI's writes and replaces every value with a
> placeholder on disk, confirmed in a plain text editor. Values had to be
> copied by hand from Upstash's dashboard. **This will bite again at cutover**,
> when a dozen production variables need to reach a local checkout — plan to
> set them in the Vercel dashboard directly and not to rely on pulling them
> down. Vercel's "Sensitive" variables also cannot be revealed again once set,
> even by an owner, so keep them in the password manager at the moment they are
> created.
