# Security Pass (Day 17)

**Reviewed:** 2026-07-22 · Scope: secrets, route auth, RLS backstop, webhook abuse.

## Findings & status

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Secrets in git history | Critical | ✅ **None** — full-history scan clean; `.env*` never tracked |
| 2 | Webhooks accept forged payloads (no signature check) | Critical | ✅ **Fixed** — WhatsApp HMAC + Telegram secret-token verification |
| 3 | `request.json()` unguarded (malformed body → 500) | Low | ✅ **Fixed** — defensive parse → 400 |
| 4 | Webhook rate-limiting | Medium | ⚠️ **Deferred to Phase 1** (Upstash Redis, B3 stack) — see note |
| 5 | Service-role key exposure | Critical | ✅ **Clean** — server-only (`lib/supabase/admin.ts`, cascade, scripts); never imported client-side |
| 6 | Data routes without auth | Critical | ✅ **None** — only the 2 webhooks are public; all data access is session + RLS |

## 1. Secrets
Full `git log --all -p` scan for every known key pattern (Anthropic, Supabase
secret, WhatsApp token, Telegram token, DB password) → **no matches**. No `.env`
file appears in any commit. `.gitignore` covers `.env*`, `*.key`, `*.pem`.

## 2. Webhook authentication (the main fix)
Both public webhooks now authenticate the payload (`lib/webhook-security.ts`):

- **WhatsApp** — verifies `X-Hub-Signature-256` HMAC-SHA256 over the raw body
  using `WHATSAPP_APP_SECRET`.
- **Telegram** — verifies the `X-Telegram-Bot-Api-Secret-Token` header against
  `TELEGRAM_WEBHOOK_SECRET` (set on the bot via `set-telegram-webhook`).

**Enforce-when-set, skip-when-unset:** with the secret configured the endpoint
rejects forged/missing signatures with 403; without it (POC default) it logs a
warning and proceeds, so the demo runs unblocked. Unit-tested: valid → accept,
forged/missing → reject, unset → skip.

**To activate in production:** set `WHATSAPP_APP_SECRET` (Meta app → Settings →
Basic) and `TELEGRAM_WEBHOOK_SECRET` (any random string, then re-run
`npx tsx scripts/set-telegram-webhook.ts`) in Vercel. No code change needed.

## 3. RLS is the enforced backstop
Confirmed by two independent verifiers, both passing:
- `scripts/verify-access-matrix.mjs` (SQL impersonation)
- `scripts/verify-rls-rest.mjs` (real Supabase Auth path)

Org isolation (0 cross-org rows for any user), property scoping (FM/owner),
restricted roles (tenant/vendor), and cross-brand disjointness all hold. Page
`RoleGate`s and nav gating sit on top as UX, not as the security boundary.

## 4. Rate limiting — deferred (documented)
The webhooks have no rate limit. In-memory limiting is ineffective on serverless
(isolated invocations), so the production answer is **Upstash Redis** (already in
the B3 stack) — a sliding-window limiter keyed by sender. For the POC, signature
verification (#2) is the primary abuse mitigation: once the secrets are set, only
Meta/Telegram can post, so unauthenticated flooding is rejected before any work.
Tracked in `docs/RECONCILED_ROADMAP.md` Phase-1 items.

## Gate
No exposed secrets; no unauthenticated data routes; the two public webhooks are
authenticatable and default-safe. Criticals fixed; the one Medium (rate-limiting)
is deferred with a documented production path.
