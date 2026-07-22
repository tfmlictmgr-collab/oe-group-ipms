# Deployment Stability (Day 16)

**Reviewed:** 2026-07-22 · **Pathway A** (already live on Vercel since Day 1).
**Gate:** nothing about demo day depends on a laptop's network connection.

## Where everything runs (all managed cloud — no laptop in the loop)

| Component | Host | Notes |
|---|---|---|
| Web app / API routes | **Vercel** (production) | `https://oe-group-ipms.vercel.app`, auto-deploys `main` |
| Database / Auth / Realtime | **Supabase** | shared by app + scripts |
| WhatsApp intake | Meta → **Vercel** webhook | callback URL is the Vercel domain |
| Telegram intake | Telegram → **Vercel** webhook | registered to the Vercel domain |
| LLM classification | **Anthropic API** | pay-as-you-go |

The demo itself (portal browsing, WhatsApp/Telegram intake, AI triage, payments,
BI) is entirely cloud-hosted. **Migrations and seeding run locally, but those are
setup steps, not demo-runtime** — once seeded, the laptop can be closed.

## Environment variables — required vs optional

Required app runtime vars — **all 9 confirmed set on Vercel production**:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (webhooks, cascade, admin client)
- `ANTHROPIC_API_KEY` (classifier)
- `DEMO_ORG_ID` (webhook ticket org)
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- `TELEGRAM_BOT_TOKEN`

Optional provider keys — **intentionally unset**; the notification cascade guards
each and logs a `skipped` attempt, so absence never breaks a flow:

- `RESEND_API_KEY`, `AFRICASTALKING_API_KEY`, `EMAIL_FROM`

Local-only (never needed on Vercel): `SUPABASE_DB_*` (migrations/seed),
`VERCEL_OIDC_TOKEN`.

## Production health check (this review)

Smoke test of demo-critical endpoints — all green:

| Endpoint | Result |
|---|---|
| `/login` | 200 |
| `/` → `/dashboard` | 307 |
| `/dashboard` (unauth) | 307 → login |
| WhatsApp webhook GET verify | 200 (Meta handshake) |
| Telegram webhook POST | 200 |

RLS behaviour confirmed against the deployed auth path
(`scripts/verify-rls-rest.mjs`): property scoping, restricted roles and
cross-brand isolation all pass.

## Demo-day checklist

1. `npm run seed` beforehand for a clean, known dataset (optional — data persists).
2. Confirm the latest production deployment is **Ready** in the Vercel dashboard.
3. Have the 9 logins ready (all password `OEGroupDemo2026!`): `demo@` (admin),
   `finance@`, `fm@`, `ops@`, `owner@`, `vendor@`, `resident@`, `tfml@`, `oea@`.
4. Nothing else runs locally — the laptop only needs a browser.

## Residual note

WhatsApp *outbound* send depends on a healthy Meta number; the verify handshake
and inbound intake are confirmed. Telegram round-trip and the cascade fallback
are proven. If demoing live inbound WhatsApp, confirm the number is active first.
