# TENTai — Security self-assessment (Phase 1)

**Who runs it:** the ICT manager, following this document step by step.
**What it is:** a structured, evidence-producing security check of the live
system, aimed at the risks this application actually carries.
**What it is not:** a substitute for the independent external penetration test
(build plan 1.11 / 6.2). That test's value is a tester who does not share our
assumptions. This one checks our assumptions, thoroughly, so the external test
starts from a clean baseline — and gives the board evidence to decide on.

Written 25 September 2026, against `v1.0.0-rc7` (live updates, Turnstile on
sign-in, TENTai as controller).

---

## 0. Before you start

### When to begin

| Part | Where | Begin when | Time |
|---|---|---|---|
| **Authorisation** (§0.1) | paper | **today** | 10 min |
| **A — Production, read-only** | `www.tfmlportal.com`, `oeaportal.com` | **as soon as rc7 is merged and live** (after the running verify finishes) | ~1.5 h |
| **B — Staging, hands-on** | `oe-group-ipms-staging.vercel.app` | after the verify run has **finished** — never while one is running, it checks staging's data | ~3 h |
| **C — Automated scans** | production (passive) + staging (active) | after A; needs Docker and k6 (`security/README.md`) | ~1.5 h |
| **D — Record and triage** (§5) | this repo | as you go | 30 min |

⚠️ **Order matters.** Part A never writes anything to production. Everything
that submits a form, uploads a file or creates a record is in **Part B, on
staging** — production must stay empty for the external test and for real
tenants' first day.

### 0.1 Written authorisation — get this first

Testing a system, even your own, should be authorised in writing by whoever
owns the risk. Send this to the board chair (or the MD) and keep the reply:

> I request authorisation to carry out a security self-assessment of the TENTai
> platform between [date] and [date], covering production
> (www.tfmlportal.com, oeaportal.com, portal.tfmlconsultant.com) in read-only
> mode and the staging environment (oe-group-ipms-staging.vercel.app) with
> active tests. No production data will be created, changed or deleted. The
> method is docs/security/SELF_ASSESSMENT.md in the TENTai repository. Findings
> will be reported to the board with the Phase 1 go/no-go.
> — [name], ICT Manager

### 0.2 What you need

- Git Bash in `C:\projects\oe-group-ipms`, on the rc7 code (`git checkout main`, `git pull`).
- **Two browsers** (or one normal window and one private window) — you will be
  signed in as two different people at once.
- **Staging test accounts:** the fixture logins in `scripts/seed-brand-roles.mjs`
  (`tfml.pm@oegroup.test`, `oea.tenant@oegroup.test`, …). Their shared password
  is in that script. **Never use them on production** — they do not exist there.
- For Part A: your own production admin accounts for TFML and OEA.

### 0.3 The stop rule

If **any** test shows you another organisation's data, or lets a role do what it
should not: **stop, screenshot it, do not continue that section**, and report it
before anything else. That is a go/no-go finding.

---

## Part A — Production, read-only

Nothing in Part A creates, changes or deletes anything.

Load the production address and **public** key into this Git Bash window (the
anon key is published in every page; it is not a secret). One command at a time:

```
URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.prod.local | cut -d= -f2- | tr -d '"\r')
```
```
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.prod.local | cut -d= -f2- | tr -d '"\r')
```
```
echo "$URL"
```
Expect `https://civwriqvghvyqtfrzftu.supabase.co`. If not, stop — you are pointed at the wrong world.

### A1. The database refuses anonymous reads

Each must print `[]` (an empty list) or an error — **never a row**.

| # | Command | Expect |
|---|---|---|
| A1.1 | `curl -s "$URL/rest/v1/tickets?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | `[]` |
| A1.2 | `curl -s "$URL/rest/v1/users?select=id,email&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | `[]` |
| A1.3 | `curl -s "$URL/rest/v1/channel_routes?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | `[]` or `permission denied` — this table holds bot tokens |
| A1.4 | `curl -s "$URL/rest/v1/bank_accounts?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | `[]` or `permission denied` |
| A1.5 | `curl -s "$URL/rest/v1/user_notifications?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"` | `[]` |

⚠️ **Do not run `scripts/verify-security-posture.mjs` against production.** It
proves anonymous writes are refused by *attempting* them — including a delete —
so if a protection were ever broken, the probe itself would damage production.
It already runs against staging in every `npm run verify`; that is where it
belongs.

### A2. Sign-in is gated by Cloudflare at the source

A bot calling Supabase directly, with no Cloudflare token:

```
curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{"email":"nobody@example.com","password":"wrong-password-1"}'
```

| # | Expect |
|---|---|
| A2.1 | an error mentioning **captcha** — never `invalid_credentials`. `invalid_credentials` means the password was checked, i.e. CAPTCHA is **off** |

### A3. Sign-in reveals nothing about who has an account

In a private window, on `https://www.tfmlportal.com/login`:

| # | Do | Expect |
|---|---|---|
| A3.1 | Sign in with an email that has **no** account and any password | *"That email and password don't match. Check both and try again."* |
| A3.2 | Sign in with **your** email and a **wrong** password | the **identical** message — word for word |
| A3.3 | **Forgot password** with an email that has no account | *"Check your email"* — the same screen a real account gets |
| A3.4 | Sign in with your **OEA** admin account on **`www.tfmlportal.com`** | the same refusal message — an OEA account cannot open TFML's door, and is not told why |
| A3.5 | …and your **TFML** account on **`oeaportal.com`** | the same refusal |
| A3.6 | Sign in properly, then **Sign out**, then press the browser's **Back** button | the login screen, never a dashboard |
| A3.7 | The operator account (`portal.tfmlconsultant.com`) | asks for the **6-digit MFA code** after the password |

### A4. Pages that need a sign-in refuse without one

In a private window (signed out), open each. **Expect a redirect to the login page, `Sign in required`, or `Not found` — never data.**

| # | Address |
|---|---|
| A4.1 | `https://www.tfmlportal.com/dashboard` |
| A4.2 | `https://www.tfmlportal.com/dashboard/ledger` |
| A4.3 | `https://www.tfmlportal.com/orgs` |
| A4.4 | `https://www.tfmlportal.com/api/records/export?type=tenant` → `Sign in required` |
| A4.5 | `https://www.tfmlportal.com/api/records/documents-zip` → `Sign in required` |
| A4.6 | `https://www.tfmlportal.com/api/analytics/report` → `Sign in required` |
| A4.7 | `https://www.tfmlportal.com/api/receipts/00000000-0000-0000-0000-000000000000` → `Sign in required` |

### A5. Guessed links reveal nothing

Signed out. Made-up tokens must fail **without** hinting whether anything exists.

**Expect for every row:** a refusal ("expired", "already used", "not found") that
names **no** person, organisation, property or amount.

| # | Address |
|---|---|
| A5.1 | `https://www.tfmlportal.com/invite/not-a-real-token` |
| A5.2 | `https://www.tfmlportal.com/tenancy/offer/not-a-real-token` |
| A5.3 | `https://www.tfmlportal.com/payout-details/not-a-real-token` |
| A5.4 | `https://www.tfmlportal.com/pay/NOT-A-REAL-REFERENCE` |
| A5.5 | `https://www.tfmlportal.com/reset-password/confirm?token=not-a-real-token` |

### A6. Scheduled jobs and webhooks refuse strangers

Each is a POST/GET with no secret. **None writes anything when refused.**

| # | Command | Expect |
|---|---|---|
| A6.1 | `curl -s -o /dev/null -w "%{http_code}\n" https://www.tfmlportal.com/api/jobs/expire-leases` | `401` |
| A6.2 | `curl -s -o /dev/null -w "%{http_code}\n" https://www.tfmlportal.com/api/jobs/raise-rent-demands` | `401` |
| A6.3 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://www.tfmlportal.com/api/webhooks/whatsapp -d '{}'` | `403` |
| A6.4 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://www.tfmlportal.com/api/webhooks/whatsapp?token=guess" -d '{}'` | `403` |
| A6.5 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://www.tfmlportal.com/api/webhooks/telegram -d '{}'` | `403` |
| A6.6 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://www.tfmlportal.com/api/webhooks/payments/flutterwave -d '{}'` | `400`, `401` or `403` — never `200` |
| A6.7 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://www.tfmlportal.com/api/webhooks/payments/simulated -d '{}'` | `403` — the fake gateway must be unreachable in production |

### A7. Transport and browser protections

```
curl -sI https://www.tfmlportal.com/login
```

| # | Expect in the output |
|---|---|
| A7.1 | `strict-transport-security: max-age=63072000; includeSubDomains` |
| A7.2 | `x-frame-options: DENY` |
| A7.3 | `x-content-type-options: nosniff` |
| A7.4 | `referrer-policy: no-referrer` |
| A7.5 | `content-security-policy-report-only:` present (enforcing it is plan 7.3) |

```
curl -sI http://tfmlportal.com
```

| A7.6 | a `301`/`308` to `https://` — plain HTTP never serves a page |

Repeat A7 for `oeaportal.com` and `portal.tfmlconsultant.com`.

### A8. No secret is shipped to the browser

Signed in on `www.tfmlportal.com`, open DevTools → **Sources** → press
Ctrl+Shift+F (search all files) and search for each:

| # | Search for | Expect |
|---|---|---|
| A8.1 | `service_role` | no match inside a key-like string |
| A8.2 | `sk_live` | no match |
| A8.3 | `FLWSECK` | no match |
| A8.4 | `SUPABASE_SERVICE_ROLE_KEY` | no match |

### A9. Brand separation on public pages (B1)

| # | Do | Expect |
|---|---|---|
| A9.1 | Open `oeaportal.com/login` and `www.tfmlportal.com/login`; read every word | each names only its own brand (and TENTai as platform) |
| A9.2 | `/legal/terms`, `/legal/refunds`, `/legal/privacy` on each host | as A9.1 (already proven by 5.10 — re-check on rc7) |
| A9.3 | The **title in the browser tab** and the favicon on each host | own brand only |
| A9.4 | Take any public link from one portal, e.g. OEA's vendor-application link `https://www.oeaportal.com/apply/<id>`, and swap the host to the **other** portal (`www.tfmlportal.com/apply/<id>`). Repeat for an invitation, a tenancy offer and a payout-details link if you have one | **Not found**: the same page a made-up address gets. Never the other brand's name or form under this host. *Found FAILING on rc7, 26 Sept 2026; fixed for rc8 (`hostServesOrg`, `verify-public-pages-host-bound`)* |

---

## Part B — Staging, hands-on

Address: `https://oe-group-ipms-staging.vercel.app`. Sign in at `/o/tfml` or
`/o/oea` with the fixture accounts. Two browsers throughout: **Browser 1** and
**Browser 2**.

### B1. One organisation cannot reach the other's records — the most important section

For each row: in **Browser 1** sign in as the **OEA** account, open a record of
that kind, and **copy the address** from the address bar. In **Browser 2**, sign
in as the **TFML** account and paste it.

**Expect:** *Not found*, a refusal, or an empty page. **Never** the record, its
title, amounts or names. Any leak here is the stop rule.

| # | Record | OEA account (Browser 1) | TFML account (Browser 2) |
|---|---|---|---|
| B1.1 | a request — `/dashboard/tickets/<id>` | `oea.pm@` | `tfml.pm@` |
| B1.2 | a property — `/dashboard/properties/<id>` | `oea.pm@` | `tfml.pm@` |
| B1.3 | a lease — `/dashboard/leases/<id>` | `oea.pm@` | `tfml.pm@` |
| B1.4 | a vendor — `/dashboard/vendors/<id>` | `oea.ops@` | `tfml.ops@` |
| B1.5 | a person — `/dashboard/people/<id>` | `oea.pm@` | `tfml.pm@` |
| B1.6 | a payment — `/dashboard/payments/<id>` | `oea.finance@` | `tfml.finance@` |
| B1.7 | a remittance — `/dashboard/remittances/<id>` | `oea.finance@` | `tfml.finance@` |
| B1.8 | a service-charge budget — `/dashboard/sc/<id>` | `oea.finance@` | `tfml.finance@` |
| B1.9 | a statement — `/dashboard/properties/<id>/statement` | `oea.finance@` | `tfml.finance@` |
| B1.10 | a receipt — `/api/receipts/<intentId>` | `oea.finance@` | `tfml.finance@` |
| B1.11 | an uploaded document or photo — right-click → *copy link* on a file | `oea.pm@` | `tfml.pm@` — and also **signed out** |

Then repeat B1.1–B1.3 the other way round (TFML record, OEA reader).

### B2. A role cannot reach beyond its job

Sign in as each account and open the addresses. **Expect** a refusal, a
redirect to the dashboard, or a page with no data — never the content.

| # | Account | Try to open | Expect |
|---|---|---|---|
| B2.1 | `tfml.tenant@` | `/dashboard/ledger` | refused |
| B2.2 | `tfml.tenant@` | `/dashboard/people` | refused |
| B2.3 | `tfml.tenant@` | `/dashboard/tickets/<id of ANOTHER tenant's request>` | not found |
| B2.4 | `tfml.vendor@` | `/dashboard/ledger` | refused |
| B2.5 | `tfml.vendor@` | `/dashboard/vendors` | refused (a vendor sees only its own company) |
| B2.6 | `tfml.viewer@` | any **Save / Approve / Delete** button | none present, or refused when pressed |
| B2.7 | `tfml.pm@` | `/dashboard/settings` | refused (administrators only) |
| B2.8 | `tfml.pm@` | `/api/records/export?type=staff` | `403` |
| B2.9 | `tfml.finance@` | approve a payment **it raised itself** | refused — the approval ladder forbids approving your own |
| B2.10 | `tfml.approver@` | approve a payment above its band (if bands are on) | refused |
| B2.11 | any non-operator | `/orgs` | *"This page is for TENTai operators"* |

### B3. File uploads refuse what they should

On staging's vendor application form (`/apply/<staging org id>`) and a tenancy
application (`/tenancy/tfml`):

| # | Upload | Expect |
|---|---|---|
| B3.1 | a `.html` file renamed to `.pdf` | refused |
| B3.2 | an `.exe` or `.js` file | refused |
| B3.3 | a file larger than the stated limit | refused, with the limit named |
| B3.4 | an `.svg` image | refused (SVG can carry script) |
| B3.5 | a normal PDF/JPG | accepted — then open it as **another org's** user (B1.11) |

### B4. Forms refuse script injection

In any free-text field you can save (a request description, a vendor note),
save exactly:

```
<img src=x onerror=alert(1)><script>alert(2)</script>
```

| # | Expect |
|---|---|
| B4.1 | the text is shown **as text**, literally — no pop-up, ever, anywhere it is displayed (list, detail page, notification, emailed copy) |

### B5. Brute force and abuse limits

| # | Do | Expect |
|---|---|---|
| B5.1 | 10 wrong passwords in a row for `tfml.viewer@` | "Too many attempts. Wait a minute and try again." at some point |
| B5.2 | Forgot password for the same address 5 times | still "Check your email" every time (it silently stops sending after 3) |

### B6. Sessions end when they should

| # | Do | Expect |
|---|---|---|
| B6.1 | Sign in as `tfml.viewer@` in Browser 1. In the **staging** SQL editor run `update users set deactivated_at = now() where email = 'tfml.viewer@oegroup.test';` then refresh Browser 1 | no data — signed out or refused on the next load |
| B6.2 | Undo it: `update users set deactivated_at = null where email = 'tfml.viewer@oegroup.test';` | the account works again |

---

## Part C — Automated scans (plan 6.1)

Follow `security/README.md` §3 exactly — it has the commands and the pre-flight
that refuses unsafe targets. In short:

| # | Tool | Target | Notes |
|---|---|---|---|
| C1 | ZAP **baseline** (passive) | `https://www.tfmlportal.com`, `https://oeaportal.com` | safe on production |
| C2 | k6 journey + spike | `https://www.tfmlportal.com` | read-only |
| C3 | k6 rate-limit | `https://www.tfmlportal.com` | fills only your own IP's bucket |
| C4 | ZAP **full** (active) | `https://oe-group-ipms-staging.vercel.app` | **staging only** — it submits forms |

`npm run use-env` must match the target before each (prod for C1–C3, staging
for C4) — the pre-flight reads that world's database.

---

## 5. Recording results

Create `docs/verify-runs/self-assessment-<YYYYMMDD>.md` and fill in one line per
test:

```
| Test | Result | Evidence | Note |
|---|---|---|---|
| A1.1 | PASS | printed [] | |
| B1.4 | FAIL | screenshot b1-4.png (not committed) | TFML ops saw OEA vendor name |
```

- **PASS** — exactly the expected result.
- **FAIL** — anything else. Severity:
  - **Critical** — any cross-organisation data (B1), a role doing another's job
    (B2), a secret in the browser (A8), CAPTCHA off (A2). Stop rule; no go-live.
  - **High** — an upload or injection that gets through (B3, B4); a missing
    transport header (A7).
  - **Medium/Low** — everything else; fix before the external test.
- **Do not commit screenshots containing personal data.** Staging fixtures are
  fine; production has none by design.

Send the finished file (or its FAIL lines) back into the build session: every
FAIL gets a fix, a retest, and a line in the plan. The completed record, with the
board's authorisation (§0.1), is what the board sees at go/no-go (6.4), alongside
the commissioned external test (1.11).
