# Phase 1 Pre-Kickoff Security Review — Findings & Fixes

Reviewed the **POC/`main` build** (the baseline Phase 1 builds on) for security and
integrity slips. Fixes below are on branch **`phase-1-hardening`**. Nothing was
applied to the shared live DB and nothing was deployed — code + migration are
staged for the Phase 1 dev DB per `HANDOFF.md`.

## Fixed on `phase-1-hardening`

| ID | Finding | Fix | Where |
|----|---------|-----|-------|
| S1 | Webhook auth *default-skipped* when the secret was unset. **Correction (2026-07-24):** `vercel env ls` shows `WHATSAPP_APP_SECRET` + `TELEGRAM_WEBHOOK_SECRET` **are set in Production** (created ~19h prior), and the deployed code enforces when a secret is present — so prod was **already authenticated** for WhatsApp and Telegram. The "live open window" was based on a stale `HANDOFF`/roadmap note. | Downgraded from urgent to **defense-in-depth**: auth now **fails closed in production** when a secret is missing (instead of silently skipping), so removing a secret or standing up a new prod env can't reopen the hole. Telegram token compare made constant-time. | `lib/webhook-security.ts` |
| S2 | `approval_threshold_amount` stored/shown but **never enforced** — any finance/admin approves any amount | Approvals **above the configured limit now require an admin** (app layer) **and** the DB rejects the transition | `app/dashboard/payments/[id]/actions.ts`, `0010` |
| S9 | `payments_update` RLS lets any admin/FM/finance PATCH a payment straight to `approved`/`remitted`, skipping the gate | **DB state-machine trigger** enforces legal transitions + gate conditions + finance/admin-only money moves | `0010` `enforce_payment_transition()` |
| S3 | `vendor_evaluations` drive the KPI payment gate but inserts were **unaudited** (gate could be gamed silently) | Audit trigger on evaluation insert | `0010` |
| S4 | `service_charges` had **no audit trigger** and allowed **hard DELETE**; no soft-delete anywhere | Audit on SC insert/update; **soft-delete** (`deleted_at`) with hard-delete blocked for users + reads filtered | `0010` |

All rules in `0010` are **skipped for the service role** (`auth.uid() IS NULL`), so
seed scripts / webhook / system writes are unaffected — the rules bind only real
authenticated users, which is the actual threat surface.

## Requires action before / at Phase 1 kickoff (cannot be done in code)

1. **S1 — already set (verified 2026-07-24).** `WHATSAPP_APP_SECRET` and
   `TELEGRAM_WEBHOOK_SECRET` exist in Vercel Production, so the live window is
   closed. Just keep them set: after this branch deploys, prod **fails closed**
   without them, so don't remove them and set the same two on any new prod
   environment. SMS callbacks get the same treatment when Africa's Talking is wired.
2. **Apply `0010` on the Phase 1 dev DB** (not the shared POC DB), then run
   `scripts/verify-access-matrix.mjs` and `scripts/verify-rls-rest.mjs`.

## Deferred — needs the dev DB + verifier (do in Phase 1, not blind)

- **S5 — FM privilege inconsistency.** `0008/0009` property-scoped the FM for
  tickets/SC/budgets/properties/units, but `vendors`/`payments`/`vendor_evaluations`
  are still org-wide for the FM. Property-scoping the money side changes visibility
  and MUST be developed against the dev DB with `verify-access-matrix.mjs` re-run —
  not patched blind. **Fold into Day 2/6.**
- **S6 — uncommitted Next.js `14 → 16` major bump, no tests/CI.** Commit or revert
  before branching Phase 1 off a known baseline; add a minimal CI smoke test
  (payment state machine + RLS verifiers) before live-money code lands.
- **S7 — inbound org hardcodes `DEMO_ORG_ID`** (both brands collapse on intake).
  Already scheduled Day 7 (per-org channel routing).
- **S8 — no Gemini failover** (triage degrades to static "needs human review"); and
  **verify the model id** `claude-sonnet-4-6` in `lib/triage.ts` — if invalid, every
  classification silently falls back. Needs a provider key; schedule with Day 13.

## Roadmap wording fix
Day 6 ("gated remittance through the existing B4 gate") would have shipped the dead
threshold + permissive RLS. `0010` + the app change close S2/S9; Day 6 should also
explicitly cover S5 (property-scope the money side) and a full admin-configurable
approval hierarchy (this fix enforces a single admin-above-threshold rule, not yet
multi-tier).
