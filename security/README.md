# Penetration test & load test — setup and runbook

**Status:** configured, not yet run. **Owner:** whoever runs the Day 12 pass —
this is written so either machine (PC1 or PC2) can execute it without the other.

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
| 7 | **k6 rate-limit check** | `npm run loadtest:ratelimit -- <url>` | production, after cutover |
| 8 | **ZAP full** (active) | `npm run pentest:full -- <url>` | **empty production only** |
| 9 | External pen test | third party | production, with written authorisation |

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
  k6/rate-limit.js              asserts the limiter actually refuses
  reports/                      output (git-ignored)
scripts/
  pentest-preflight.mjs         refuses unsafe targets; wired into pentest:full
  verify-security-posture.mjs   the database boundary (30 checks)
```
