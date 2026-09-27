# Security self-assessment, Part A: production, read-only

**Method:** `docs/security/SELF_ASSESSMENT.md` Part A, checked against the code on
26 Sept 2026. Every address, expected code, header and message in it matches
what `v1.0.0-rc7` actually does.
**Target:** production (`civwriqvghvyqtfrzftu`), serving `v1.0.0-rc7`.
**Authorised by:** _name, role, date of the board's written reply (§0.1)_. **Don't start without it.**
**Run by:** _name_, _date_, _start–end time_.

Result: **PASS**, **FAIL** (with severity per §5), or **N/A** (with the reason).
Evidence: what you saw, briefly, e.g. `printed []` or `401`. **Paste no keys or
tokens.** Screenshots stay on your machine and aren't committed.

⚠️ **Stop rule (§0.3):** if anything shows another organisation's data, or a
secret, stop that section, screenshot it, and report it before continuing.

| Test | What | Result | Evidence |
|---|---|---|---|
| A1.1 | tickets: anonymous read | PASS | 27 Sept, operator-reported |
| A1.2 | users: anonymous read | PASS | 27 Sept, operator-reported |
| A1.3 | channel_routes: anonymous read | PASS | 27 Sept, operator-reported |
| A1.4 | bank_accounts: anonymous read | PASS | 27 Sept, operator-reported |
| A1.5 | user_notifications: anonymous read | PASS | 27 Sept, operator-reported |
| A2.1 | sign-in without a CAPTCHA token is refused for captcha | PASS | 27 Sept, operator-reported |
| A3.1 | unknown email → generic refusal | PASS | 27 Sept, operator-reported |
| A3.2 | your email, wrong password → identical refusal | PASS | 27 Sept, operator-reported |
| A3.3 | forgot password, unknown email → "Check your email" | PASS | 27 Sept, operator-reported |
| A3.4 | OEA account on tfmlportal.com → same refusal | PASS | 27 Sept, operator-reported |
| A3.5 | TFML account on oeaportal.com → same refusal | PASS | 27 Sept, operator-reported |
| A3.6 | sign out, then Back → login screen | PASS | 27 Sept, operator-reported |
| A3.7 | operator account asks for the 6-digit MFA code | PASS | 27 Sept, operator-reported |
| A4.1 | /dashboard signed out | PASS | 27 Sept, operator-reported |
| A4.2 | /dashboard/ledger signed out | PASS | 27 Sept, operator-reported |
| A4.3 | /orgs signed out | PASS | 27 Sept, operator-reported |
| A4.4 | /api/records/export signed out | PASS | 27 Sept, operator-reported |
| A4.5 | /api/records/documents-zip signed out | PASS | 27 Sept, operator-reported |
| A4.6 | /api/analytics/report signed out | PASS | 27 Sept, operator-reported |
| A4.7 | /api/receipts/0000… signed out | PASS | 27 Sept, operator-reported |
| A5.1 | /invite/not-a-real-token | PASS | 27 Sept, operator-reported |
| A5.2 | /tenancy/offer/not-a-real-token | PASS | 27 Sept, operator-reported |
| A5.3 | /payout-details/not-a-real-token | PASS | 27 Sept, operator-reported |
| A5.4 | /pay/NOT-A-REAL-REFERENCE | PASS | 27 Sept, operator-reported |
| A5.5 | /reset-password/confirm?token=… | PASS | 27 Sept, operator-reported |
| A6.1 | jobs/expire-leases → 401 | PASS | 27 Sept, operator-reported |
| A6.2 | jobs/raise-rent-demands → 401 | PASS | 27 Sept, operator-reported |
| A6.3 | WhatsApp webhook, no token → 403 | PASS | 27 Sept, operator-reported |
| A6.4 | WhatsApp webhook, guessed token → 403 | PASS | 27 Sept, operator-reported |
| A6.5 | Telegram webhook, no secret → 403 | PASS | 27 Sept, operator-reported |
| A6.6 | Flutterwave webhook, unsigned → 400/401/403 (503 if the rate limiter is down) | PASS | 27 Sept, operator-reported |
| A6.7 | simulated gateway → 403 | PASS | 27 Sept, operator-reported |
| A7.1 www.tfmlportal.com | strict-transport-security | PASS | 27 Sept, operator-reported |
| A7.2 www.tfmlportal.com | x-frame-options: DENY | PASS | 27 Sept, operator-reported |
| A7.3 www.tfmlportal.com | x-content-type-options: nosniff | PASS | 27 Sept, operator-reported |
| A7.4 www.tfmlportal.com | referrer-policy: no-referrer | PASS | 27 Sept, operator-reported |
| A7.5 www.tfmlportal.com | content-security-policy-report-only present | PASS | 27 Sept, operator-reported |
| A7.6 www.tfmlportal.com | http:// redirects to https:// | PASS | 27 Sept, operator-reported |
| A7.1 oeaportal.com | strict-transport-security | PASS | 27 Sept, operator-reported |
| A7.2 oeaportal.com | x-frame-options: DENY | PASS | 27 Sept, operator-reported |
| A7.3 oeaportal.com | x-content-type-options: nosniff | PASS | 27 Sept, operator-reported |
| A7.4 oeaportal.com | referrer-policy: no-referrer | PASS | 27 Sept, operator-reported |
| A7.5 oeaportal.com | content-security-policy-report-only present | PASS | 27 Sept, operator-reported |
| A7.6 oeaportal.com | http:// redirects to https:// | PASS | 27 Sept, operator-reported |
| A7.1 portal.tfmlconsultant.com | strict-transport-security | PASS | 27 Sept, operator-reported |
| A7.2 portal.tfmlconsultant.com | x-frame-options: DENY | PASS | 27 Sept, operator-reported |
| A7.3 portal.tfmlconsultant.com | x-content-type-options: nosniff | PASS | 27 Sept, operator-reported |
| A7.4 portal.tfmlconsultant.com | referrer-policy: no-referrer | PASS | 27 Sept, operator-reported |
| A7.5 portal.tfmlconsultant.com | content-security-policy-report-only present | PASS | 27 Sept, operator-reported |
| A7.6 portal.tfmlconsultant.com | http:// redirects to https:// | PASS | 27 Sept, operator-reported |
| A8.1 | search: service_role → no match | PASS | 27 Sept, operator-reported |
| A8.2 | search: sk_live → no match | PASS | 27 Sept, operator-reported |
| A8.3 | search: FLWSECK → no match | PASS | 27 Sept, operator-reported |
| A8.4 | search: SUPABASE_SERVICE_ROLE_KEY → no match | PASS | 27 Sept, operator-reported |
| A9.1 www.tfmlportal.com | login page names only its own brand | PASS | 27 Sept, operator-reported |
| A9.2 www.tfmlportal.com | terms / refunds / privacy name only its own brand | PASS | 27 Sept, operator-reported |
| A9.3 www.tfmlportal.com | tab title and favicon: own brand only | PASS | 27 Sept, operator-reported |
| A9.1 oeaportal.com | login page names only its own brand | PASS | 27 Sept, operator-reported |
| A9.2 oeaportal.com | terms / refunds / privacy name only its own brand | PASS | 27 Sept, operator-reported |
| A9.3 oeaportal.com | tab title and favicon: own brand only | PASS | 27 Sept, operator-reported |
| A9.4 | a public link with its host swapped to the other portal → not found | **FAIL** (High, B1) | `oeaportal.com/apply/<OEA id>` opened on `www.tfmlportal.com` showing OEA's name and vendor form. Found by the operator, 26 Sept; the same gap was on 5 more public pages. Fixed on the branch for rc8 (`08f93af`); retest once rc8 is live |

## Summary

- PASS: _n_ · FAIL: _n_ (Critical _n_, High _n_, Medium/Low _n_) · N/A: _n_
- Findings sent to the build session: _date_

---

# Part C: automated scans (started 27 Sept 2026)

| Run | Target | Result | What it means |
|---|---|---|---|
| Direct `zap-full-scan.py` (not via `npm run pentest:*`) | `https://oeaportal.com` (production, **active**) | 140 PASS, 1 WARN, 0 FAIL, but **void** | Outside the method: no pre-flight, no exclusions, and active on production. Only 8 URLs were reached, and the bare domain answers a 308 redirect, so it mostly tested the redirect. No finding counts for or against. Ran with `--env-file .env.local`: don't repeat that |
| ZAP 40025 *Proxy Disclosure* (WARN, ×4) | the 308 redirects on `oeaportal.com` | **Accepted, informational** | Vercel's edge answering for the redirect. Not the application; nothing to fix |
| C1 baseline | `https://www.oeaportal.com` (the redirect was followed: 152 endpoints) | **0 High · 3 Medium · 2 Low** | Triaged below, 27 Sept. One Low is fixed for rc8 and the rest are accepted with reasons. Same triage for `https://www.tfmlportal.com` below |

**C1 triage (www.oeaportal.com):**

| ZAP alert | Risk | Decision | Why |
|---|---|---|---|
| CSP header not set | Medium | **Known, tracked (plan 7.3)** | The CSP ships as *report-only* on purpose, and promoting it to enforcing is 7.3, after UAT's console is clean. ZAP lists the report-only header separately (Informational) |
| Cross-domain misconfiguration (`Access-Control-Allow-Origin: *`) | Medium | **Accepted** | On `/monitoring`, the Sentry tunnel (`tunnelRoute`), which accepts error reports and returns nothing. None of our code sets the header. `*` also forbids credentials, so no signed-in content can be read cross-origin |
| Sub-resource integrity missing | Medium | **False positive** | The evidence is a `<link rel="preload" as="image">` of OEA's logo. SRI applies to scripts and styles, not images |
| `X-Powered-By: Next.js` | Low | **Fixed for rc8** | `poweredByHeader: false` in `next.config.mjs` |
| Big redirect detected | Low | **Accepted** | The `/` → `/o/oea` redirect body is Next's own six-character link. Nothing sensitive |
| "Credit card in URL" | Info | **False positive** | `/monitoring?o=…&p=…` carries Sentry's organisation and project IDs |
| C4 full | `http://localhost:3000` | **did not run** | ZAP's container stopped in the AJAX spider, before the active scan, so nothing was attacked. **Finding C-PF (Medium, tooling):** the pre-flight cleared it while its environment loaded nothing (`injected env (0)`). Its checks read a failed query as an empty database. **Fixed:** it now names the database, refuses production, and stops on any unreadable query |

**C1 triage (www.tfmlportal.com, 27 Sept, 34 + 365 URLs):** **0 High · 3 Medium · 2 Low**, the same alerts as OEA with the same decisions. One addition: here the wildcard `Access-Control-Allow-Origin: *` is also listed on the pages (`/`, `/login`, `/o/tfml`). None of our code sets it. It is Vercel's header on responses it serves from cache, and a wildcard forbids credentials, so a third-party site can read only what an anonymous visitor sees. **Accepted (Low)**, and flagged for the external tester.

**Emptiness re-check, 27 Sept:** users 3 → 4, invitations 2 → 4. OEA's administrator invited a tenant on production on 26 Sept: a gmail.com address (revoked), then an @oegroup.test fixture address (accepted, account created). No property, unit or lease is linked. A **test account on production** (Medium, process): removed with `docs/sql/remove-test-tenant-20260926.sql`.

**C2a, k6 weekday journey (27 Sept), `https://tent-ai-production.vercel.app`: PASS.** 12,760 requests over 7 minutes, ramping to 25 concurrent visitors. p(95) **498 ms** (threshold 2,500); **0.00%** failed (threshold < 2%); **0.00%** 429s under ordinary load (threshold < 1%); 1,595 iterations complete, 0 interrupted. The anonymous-refusal checks on signed-in pages run in every iteration.

**C2b, k6 spike (27 Sept), `https://tent-ai-production.vercel.app`: PASS.** 12,988 requests in 2m20s (about 93/s average, up to 63 concurrent). **0** server errors (threshold: none); p(99) **453 ms** (threshold 8,000); checks **25,976/25,976 (100%)**. No 429s: at this volume nothing needed shedding, since the limiter guards sign-in, intake and payment routes, not page views. 36 iterations were dropped by k6 on the client (it could not start visitors fast enough at the peak), so they were never sent and don't count against the server.

**Test tenant: closed (27 Sept).** Deactivated and released through People (the address is now a `…@invalid` placeholder, and the sign-in is banned). Both OEA tenant invitations deleted; the gmail one was the operator's own `+` alias, so no outside person was emailed. **Production baseline from here: 3 active users (operator, TFML admin, OEA admin), 1 retired test account, 2 accepted invitations; tickets, vendors, applications, properties, units, leases and ledger entries all 0.**

**C3, k6 rate-limit (27 Sept), `https://www.tfmlportal.com`: PASS.** 1,180 unsigned posts to `/api/webhooks/telegram` at 40/s for 30 s. **207** refused as forged (403) while under the limit, then **973** dropped by the per-IP limiter (threshold count > 0 ✓); **0** server errors; checks 1,180/1,180. 207 admitted to the signature check in 30 s is a little under the README's ~300 rule of thumb, which fits a sliding-window limit of about 100 per 10 s: the configured limit, counted strictly.

**Part C status:** C1 ✅ · C2a ✅ · C2b ✅ · C3 ✅ · C-PF fixed · **C4 (active scan, staging) at the rc8 run.**

---

# Part B: staging, hands-on

**Target:** `https://oe-group-ipms-staging.vercel.app` (serving rc7). Fixture accounts only.
**Run by:** _name_, _date_.

⚠️ Stop rule (§0.3): any other organisation's data in B1, or a role doing another's job in B2, means stop that section, screenshot, and report.

| Test | What | Result | Evidence |
|---|---|---|---|
| B1.1 | OEA request opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.2 | OEA property opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.3 | OEA lease opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.4 | OEA vendor opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.5 | OEA person opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.6 | OEA payment opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.7 | OEA remittance opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.8 | OEA service-charge budget opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.9 | OEA statement opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.10 | OEA receipt opened by TFML → not found | PASS | 27 Sept, operator-reported |
| B1.11 | OEA file link: token stripped → refused; after expiry → refused (fresh link may open — not a fail) | PASS | 27 Sept, operator-reported |
| B1.1r | TFML request opened by OEA → not found | PASS | 27 Sept, operator-reported |
| B1.2r | TFML property opened by OEA → not found | PASS | 27 Sept, operator-reported |
| B1.3r | TFML lease opened by OEA → not found | PASS | 27 Sept, operator-reported |
| B2.1 | tenant → /dashboard/ledger refused | PASS | 27 Sept, operator-reported |
| B2.2 | tenant → /dashboard/people refused | PASS | 27 Sept, operator-reported |
| B2.3 | tenant → another tenant's request not found | PASS | 27 Sept, operator-reported |
| B2.4 | vendor → /dashboard/ledger refused | PASS | 27 Sept, operator-reported |
| B2.5 | vendor → /dashboard/vendors refused | PASS | 27 Sept, operator-reported |
| B2.6 | viewer → no Save/Approve/Delete, or refused | PASS | 27 Sept, operator-reported |
| B2.7 | pm → /dashboard/settings refused | PASS | 27 Sept, operator-reported |
| B2.8 | pm → export?type=staff → 403 | PASS | 27 Sept, operator-reported |
| B2.9 | finance → no approve option on its own payment | PASS | 27 Sept, operator-reported |
| B2.10 | approver above band → refused (N/A while bands off) | N/A | amount bands are off on staging; operator reported the section passing |
| B2.11 | non-operator → /orgs → operators-only page | PASS | 27 Sept, operator-reported |
| B3.1 | .html renamed .pdf → accepted as PDF; opens as broken PDF / downloads, never a web page (T and R) | PASS | 27 Sept, staging rc7; operator-reported, both forms |
| B3.2 | .exe / .js → refused (T and R) | PASS | 27 Sept, staging rc7; operator-reported, both forms |
| B3.3 | over the size limit → refused, limit named (T 10 MB, R 2 MB) | PASS | 27 Sept, staging rc7; operator-reported, both forms |
| B3.4 | .svg → refused (T and R) | PASS | 27 Sept, staging rc7; operator-reported, both forms |
| B3.5 | normal PDF/JPG → accepted; unreachable by the other org per B1.11 (T and R) | PASS | 27 Sept, staging rc7; operator-reported, both forms |
| B4.1 | script text shown literally everywhere, no pop-up | PASS | 27 Sept, staging rc7: tenant list, PM board and bell show the AI title (no script run); `tfml.admin` sees the Original message as literal text; no pop-up anywhere |
| B5.1 | 10 wrong passwords → identical refusal each time (rc7) | PASS | 27 Sept, staging rc7; operator-reported |
| B5.2 | 5 forgot-password requests → "Check your email" every time | PASS | 27 Sept, staging rc7; operator-reported |
| B6.1 | deactivate in SQL → open session reaches nothing | PASS | 27 Sept, staging rc7; operator-reported |
| B6.2 | reactivate → account works again | PASS | 27 Sept, staging rc7; operator-reported |

**Found during B4 (27 Sept): B4-F1, Medium, role reach.** Every new request was
announced to every admin, FM and PM in the organisation. The test request came
from a tenant with no lease, so it had no property: `tfml.pm` was alerted,
couldn't open it, and didn't see it on their board. **Operator's rule, built for
rc8 (0304):** a new request alerts only whoever can open it and act on it. An
administrator sees everything but acts only on work left 24 hours (nobody
assigned, or nobody acting). Proven locally by `verify-request-alert-audience`
(36/36). To re-prove on staging at the rc8 cut.

Side result: the AI triage treated the injected text as data. It titled the
request *"Message contains only script/HTML injection content…"*, set it to Low,
and ran nothing.
