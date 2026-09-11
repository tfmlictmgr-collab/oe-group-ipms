# Penetration test & load test — setup and runbook

**Status:** run against **dev**, 8–9 August 2026 — steps 1–7 complete, steps 8
and 9 still pending their window and a third party. Results and dispositions:
`docs/DAY12_SECURITY_PASS.md`; what remains open: `docs/DAY12_CLOSEOUT.md`.
The whole sequence re-runs unchanged against production at cutover.

**Owner:** whoever runs the Day 12 pass — this is written so either machine
(PC1 or PC2) can execute it without the other. ⚠️ **That is not quite true
today: only PC2 has Docker, so only PC2 can run ZAP** (steps 4 and 8). k6 and
gitleaks are on both. See `DAY12_CLOSEOUT.md` §9.

Everything here is prepared against **your own system, on your own
infrastructure, before real clients are onboarded**. `GO_LIVE_CHECKLIST.md` §1
requires this pass to target production specifically.

---

## 0. Read this first — why an active scan here is not routine

Most web apps can take an active scan casually. **This one cannot**, for two
reasons that are invisible from the outside:

1. **Next.js Server Actions are POSTs to the page's own URL**, identified only
   by a `Next-Action` header. An active scanner replays captured requests with
   mutated parameters. A captured *"Send payout"* or *"Approve payment"* carries
   a real finance session — so the replay satisfies the B4 gate exactly as the
   original did.
2. **`/api/webhooks/payments/*` accepts signed gateway callbacks**, and
   `/api/jobs/*` includes a job that **purges personal data**.

So `security/zap/automation-full.yaml` excludes money, job and webhook routes,
and `scripts/pentest-preflight.mjs` refuses to clear a target where those
exclusions would not be enough. **The pre-flight is not advisory** — it is wired
into `npm run pentest:full` and blocks the run.

> **The trade this makes, stated plainly:** the active scan therefore says
> *nothing* about the payment gate. That is deliberate — the gate is tested far
> more precisely by `verify-payment-gate`, `verify-remittance`,
> `verify-remittance-race`, `verify-invoice-appeal` and `verify-role-surface`,
> which exercise it as real users with real roles and assert the refusals. A
> scanner guessing at parameters is a worse test of that surface *and* a
> dangerous one.

---

## 1. Install (once, per machine)

Nothing here is installed by `npm install` — these are external tools.

### Docker Desktop — required for ZAP

ZAP is run as a container; there is no reliable Windows-native path.

- <https://www.docker.com/products/docker-desktop/>
- Verify: `docker --version` and `docker info` (the daemon must be running).

### k6 — load testing

```bash
winget install k6 --source winget
```

macOS/Linux: `brew install k6` · Verify: `k6 version`

### gitleaks — secret scanning (optional but recommended)

```bash
winget install gitleaks
```

`gitleaks detect` should exit **0** with *"no leaks found"*. It has four known
false positives — two invented Flutterwave key *shapes* that
`verify-fx-collections` uses to prove `gatewayMode()` reads the prefix, and two
`key:` form-field names — each recorded with its reason in `.gitleaksignore`.

⚠️ **Do not add a new fingerprint there to make a run pass.** The point of that
file is that the healthy state is a clean exit, so a real leak shows up as a
change of *state* rather than a change of *count* nobody was reading. Anything
new is investigated first.

### What is NOT needed

- **Nuclei / sqlmap / Burp** — deliberately not adopted. ZAP's active scan plus
  the verification suites cover the same ground for this stack, and each extra
  tool is another set of payloads that could reach a Server Action.
- **testssl.sh** — TLS terminates at Vercel's edge; its posture is Vercel's, not
  ours, and is covered contractually rather than by us scanning it.

---

## 2. Set the scan credentials

The active scan signs in as a **deliberately low-privilege** account. Scanning
as an administrator answers the wrong question (*"can an admin do admin
things?"*) while doing maximum damage.

Add to `.env.local` — **never commit these**:

```
ZAP_USER=uat.tenant@<your-domain>
ZAP_PASSWORD=<the UAT tenant password>
```

⚠️ On **production**, create a throwaway tenant for the scan and **deactivate it
afterwards**. Do not reuse a real person's account: the scan will submit forms
as them, and their name ends up on the audit trail against machine-generated
input.

---

## 3. The order to run things

Each step gates the next. Do not skip ahead.

| # | Step | Command | Safe against |
|---|---|---|---|
| 1 | Database boundary | `node scripts/verify-security-posture.mjs` | anything |
| 2 | Full verification suite | `npm run verify` | anything |
| 3 | Dependency + secret scan | `npm audit` · `gitleaks detect` | anything |
| 4 | **ZAP baseline** (passive) | `npm run pentest:baseline -- <url>` | **anything, incl. production with real data** |
| 5 | **k6 weekday profile** | `npm run loadtest -- <url>` | anything (read-only) |
| 6 | **k6 spike** | `npm run loadtest:spike -- <url>` | anything, but expect 429s |
| 7 | **k6 rate-limit check** | `npm run loadtest:ratelimit -- <url>` | anything (rewritten 2026-08-09 — see below) |
| 8 | **ZAP full** (active) | `npm run pentest:full -- <url>` | **empty production only** |
| 9 | External pen test | third party | production, with written authorisation |

### ⚠️ Never target a deployment-specific URL

Every command above takes a URL. Give it the **production alias or a custom
domain** (`tfmlportal.com`, `oeaportal.com`, `oe-group-ipms-dev.vercel.app`) —
never a per-deployment URL of the shape `…-abc123-<team>.vercel.app`.

Vercel **Deployment Protection** is enabled on this project: those URLs answer
`302` to Vercel's SSO for pages and `401` for API routes, **before any
application code runs**. A scan or load test pointed there measures Vercel's
sign-in wall, sees nothing, and reports a clean bill of health for a target it
never reached. Measured 9 Aug 2026 against both a Preview and a per-deployment
Production URL.

The same fact is why Preview deployments having no Upstash credentials is
**not** an exposure: there is no anonymous surface behind that wall for a
missing limiter to fail to protect.

### On step 7 — what "refused" looks like here

⚠️ **Nothing in this application ever answers 429.** Every rate-limited route
is deliberately quiet under abuse: the intake webhooks return `200 "OK"` when
the per-IP gate trips (so Telegram/Meta/the payment gateways do not
retry-storm), and `/reset-password`'s gate returns the same `ok()` as success,
so a prober cannot learn that an address was tried recently.

`security/k6/rate-limit.js` therefore does **not** look for a status code. It
hammers `POST /api/webhooks/telegram` with no secret token and watches for the
refusal to *change shape*: `403` (bad token) while under the limit, `200 "OK"`
(dropped by the per-IP gate) once over it. `requests_rate_limited > 0` is the
threshold.

A healthy run allows roughly `100 × (duration ÷ 10 s)` requests before the flip
— matching `INTAKE_LIMITS.coarsePerIp` — which doubles as a check that the
configured limit is the limit actually running. The probe is keyed on the
source IP, so it only ever fills the bucket for the machine running it; real
Telegram traffic is untouched.

> Its earlier version POSTed plain JSON at `/reset-password`, whose handler is
> a Server Action reachable only via a build-specific `Next-Action` header. It
> got a flat 405 and reported `requests_refused: 0` forever. If you see that
> number again, suspect the target, not the limiter — and cross-check with
> `node scripts/verify-rate-limit.mjs`, which exercises the limiter directly.

### The window for step 8

`GO_LIVE_CHECKLIST.md` states production starts **empty** and the first real org
arrives through the real onboarding flow. **That gap is when the active scan
runs.** Afterwards, the database holds client data and the answer is a
third-party test against a staging clone instead.

The pre-flight enforces this: it refuses if any remittance has ever been sent
from the target's database, and warns on tenant applications and ledger volume.

---

## 4. Reading the results

Reports land in `security/reports/` (git-ignored — they name live hosts and
findings).

**Triage order:** anything touching authentication, session handling or
cross-org isolation first, regardless of the tool's own severity. A "medium"
that lets one brand see another is worse than a "high" missing header.

⚠️ **Expect these, and do not chase them:**

- *Missing Anti-CSRF tokens* on Server Action POSTs — Next.js protects these
  with Origin checking and the Action ID, not a form token. ZAP does not know
  that.
- *Cookie without SameSite* on Supabase auth cookies — set by the Supabase SSR
  library; verify the flags rather than "fixing" them here.
- *X-Powered-By / Server headers* — Vercel's, not ours.
- 429 responses reported as errors during the spike — that is the limiter
  working, which is what `spike.js` asserts.
- *Information Disclosure — Sensitive Information in URL* (often flagged as
  "credit card information") on `/monitoring?o=…&p=…&r=…` — that's Sentry's
  `tunnelRoute` (`next.config.mjs`), carrying Sentry org/project/region IDs.
  A numeric ID occasionally passes ZAP's Luhn check; it is not payment data.

Everything else gets an entry in `docs/DAY12_SECURITY_PASS.md` with a decision:
fixed, accepted with a reason, or deferred with an owner.

---

## 5. Rules of engagement

Fill in before step 8 or 9, and keep it with the report.

| | |
|---|---|
| Authorised by | _(name, role, date)_ |
| Target | _(exact hostnames — the aliases, not the deployment URL)_ |
| Window | _(date/time, and the timezone)_ |
| Out of scope | Supabase, Vercel, Paystack, 360dialog infrastructure — **third-party systems we do not own and must not test** |
| Data handling | Reports name live hosts; store with the compliance pack, not in the repo |
| Abort condition | Any 5xx sustained beyond 60s, or any real money movement observed |
| Contact during test | _(name, phone)_ |

⚠️ **Never point any of this at Supabase's, Vercel's or Paystack's own
infrastructure.** Scanning a provider you do not own is unauthorised regardless
of what you host there, and their terms prohibit it.

---

## 6. Files

```
security/
  README.md                     this runbook
  zap/automation-baseline.yaml  passive scan plan  — safe anywhere
  zap/automation-full.yaml      active scan plan   — exclusions are load-bearing
  k6/journey.js                 weekday profile, read-only, doubles as an
                                anonymous-access assertion
  k6/spike.js                   burst; asserts graceful shedding, no 5xx
  k6/rate-limit.js              asserts the limiter actually refuses — reads the
                                403→200 flip, not a 429 (see step 7 above)
  reports/                      output (git-ignored)
scripts/
  pentest-preflight.mjs         refuses unsafe targets; wired into pentest:full
  verify-security-posture.mjs   the database boundary (30 checks)
  verify-rate-limit.mjs         the limiter directly, without HTTP — the
                                cross-check when the k6 numbers look wrong
.gitleaksignore                 the four known false positives, with reasons
docs/
  DAY12_SECURITY_PASS.md        what the 8–9 Aug run found, and each decision
  DAY12_FOLLOWUPS.md            PC2's handover — all six now closed
  DAY12_CLOSEOUT.md             what is STILL open, who owns it, and when
```
