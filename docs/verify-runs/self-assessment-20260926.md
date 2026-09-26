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

## Summary

- PASS: _n_ · FAIL: _n_ (Critical _n_, High _n_, Medium/Low _n_) · N/A: _n_
- Findings sent to the build session: _date_
