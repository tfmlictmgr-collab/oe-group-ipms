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
| A1.1 | tickets: anonymous read | | |
| A1.2 | users: anonymous read | | |
| A1.3 | channel_routes: anonymous read | | |
| A1.4 | bank_accounts: anonymous read | | |
| A1.5 | user_notifications: anonymous read | | |
| A2.1 | sign-in without a CAPTCHA token is refused for captcha | | |
| A3.1 | unknown email → generic refusal | | |
| A3.2 | your email, wrong password → identical refusal | | |
| A3.3 | forgot password, unknown email → "Check your email" | | |
| A3.4 | OEA account on tfmlportal.com → same refusal | | |
| A3.5 | TFML account on oeaportal.com → same refusal | | |
| A3.6 | sign out, then Back → login screen | | |
| A3.7 | operator account asks for the 6-digit MFA code | | |
| A4.1 | /dashboard signed out | | |
| A4.2 | /dashboard/ledger signed out | | |
| A4.3 | /orgs signed out | | |
| A4.4 | /api/records/export signed out | | |
| A4.5 | /api/records/documents-zip signed out | | |
| A4.6 | /api/analytics/report signed out | | |
| A4.7 | /api/receipts/0000… signed out | | |
| A5.1 | /invite/not-a-real-token | | |
| A5.2 | /tenancy/offer/not-a-real-token | | |
| A5.3 | /payout-details/not-a-real-token | | |
| A5.4 | /pay/NOT-A-REAL-REFERENCE | | |
| A5.5 | /reset-password/confirm?token=… | | |
| A6.1 | jobs/expire-leases → 401 | | |
| A6.2 | jobs/raise-rent-demands → 401 | | |
| A6.3 | WhatsApp webhook, no token → 403 | | |
| A6.4 | WhatsApp webhook, guessed token → 403 | | |
| A6.5 | Telegram webhook, no secret → 403 | | |
| A6.6 | Flutterwave webhook, unsigned → 400/401/403 (503 if the rate limiter is down) | | |
| A6.7 | simulated gateway → 403 | | |
| A7.1 www.tfmlportal.com | strict-transport-security | | |
| A7.2 www.tfmlportal.com | x-frame-options: DENY | | |
| A7.3 www.tfmlportal.com | x-content-type-options: nosniff | | |
| A7.4 www.tfmlportal.com | referrer-policy: no-referrer | | |
| A7.5 www.tfmlportal.com | content-security-policy-report-only present | | |
| A7.6 www.tfmlportal.com | http:// redirects to https:// | | |
| A7.1 oeaportal.com | strict-transport-security | | |
| A7.2 oeaportal.com | x-frame-options: DENY | | |
| A7.3 oeaportal.com | x-content-type-options: nosniff | | |
| A7.4 oeaportal.com | referrer-policy: no-referrer | | |
| A7.5 oeaportal.com | content-security-policy-report-only present | | |
| A7.6 oeaportal.com | http:// redirects to https:// | | |
| A7.1 portal.tfmlconsultant.com | strict-transport-security | | |
| A7.2 portal.tfmlconsultant.com | x-frame-options: DENY | | |
| A7.3 portal.tfmlconsultant.com | x-content-type-options: nosniff | | |
| A7.4 portal.tfmlconsultant.com | referrer-policy: no-referrer | | |
| A7.5 portal.tfmlconsultant.com | content-security-policy-report-only present | | |
| A7.6 portal.tfmlconsultant.com | http:// redirects to https:// | | |
| A8.1 | search: service_role → no match | | |
| A8.2 | search: sk_live → no match | | |
| A8.3 | search: FLWSECK → no match | | |
| A8.4 | search: SUPABASE_SERVICE_ROLE_KEY → no match | | |
| A9.1 www.tfmlportal.com | login page names only its own brand | | |
| A9.2 www.tfmlportal.com | terms / refunds / privacy name only its own brand | | |
| A9.3 www.tfmlportal.com | tab title and favicon: own brand only | | |
| A9.1 oeaportal.com | login page names only its own brand | | |
| A9.2 oeaportal.com | terms / refunds / privacy name only its own brand | | |
| A9.3 oeaportal.com | tab title and favicon: own brand only | | |
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
