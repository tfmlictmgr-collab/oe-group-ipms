# Stage 5.10 — production, re-proved at cutover

**Run:** 24 September 2026, against the production project, read-only.
**Queries:** `docs/sql/stage3-production-proof.sql` — emptiness, and the
SECURITY DEFINER privilege audit.

Stage 3.6 proved production empty on 21 September. This re-proves it at the
moment of cutover, because emptiness is the one claim that decays silently:
nothing announces the first row.

## Emptiness — PASS

Every table naming tenants, tickets, leases, invoices, payments or people
reads **0**: `properties`, `units`, `leases`, `tickets`, `tenant_applications`,
`vendors`, `payments`, `payment_intents`, `ledger_entries`, `ledger_postings`,
`remittances`, `rent_charges`, `service_charges`, `offline_payment_claims`,
`payout_recipients`, `gateway_events`, `channel_consents`.

The non-zero rows are what the migrations and provisioning created, and
nothing else:

| table | rows | why |
|---|---|---|
| `role_permissions` | 1560 | the B7 baseline, ×4 orgs |
| `_migrations` | 321 | matches schema `0300` — 3.3 finished |
| `audit_log` | 202 | provisioning, brand and domain binds |
| `org_nodes` | 139 | the Nigeria geography seed, per org |
| `capabilities` | 39 | baseline |
| `nigeria_states` | 37 | reference data |
| `property_types` / `unit_types` | 29 / 27 | reference data |
| `application_document_requirements` | 24 | reference data |
| `vendor_document_requirements` | 15 | reference data |
| `mfa_backup_codes` | 8 | **evidence 5.4's MFA is really on** |
| `org_modules` | 8 | per-org module flags |
| `password_resets` | 8 | the bootstrap link and its reissues |
| `operator_actions` | 6 | **evidence 5.8's domain binds were recorded** |
| `orgs` | 4 | operator + TFML + OEA + client |
| `users` | 3 | the operator admin and two invited administrators |
| `invitations` | 2 | those two, still pending |
| `ledger_accounts` | 2 | see the finding below |
| `org_brand_associations` | 2 | |
| `user_notifications` | 2 | |
| `email_deliveries` | 1 | the bootstrap mail |

## ⚠️ Finding — `bank_accounts` is 0, and that blocks the money path

Locked decision 2 requires a **segregated client-funds bank account**. There
is none, in any organisation, in any currency.

This is not paperwork waiting on a bank. It is a row that does not exist, and
the code depends on it:

- `client_funds_bank_account(org, currency)` (`0146`) **raises** when there is
  none — and raises when there is more than one, rather than picking, because
  "a payout that guessed which account it left would reconcile against a
  statement it never appeared on".
- `submit_offline_payment_claim` takes `p_bank_account_id`. With no account
  there is nothing to pass, so **the off-platform payment route — the whole
  money path for this cutover, with no gateway key — cannot be exercised**.
- `ensure_default_ledger_accounts` is called from
  `app/dashboard/settings/bank-actions.ts`, i.e. when an administrator adds a
  bank account. That is why `ledger_accounts` reads **2** rather than a chart
  per organisation: the chart is built when the account is, and none has been.

**1.9 is therefore a hard gate on this cutover, not a Stage 1 formality.**
Until each organisation has its client-funds account recorded, no real money
can be received through the system, by any route.

## Privilege audit — clean

The four functions that made `0214` refuse to apply on the fresh production
database — `sender_open_requests`, `resolve_ticket_by_ref`,
`conversation_state`, `remember_conversation_state` — are **absent from the
listing entirely**. `0213a`'s revoke held.

Every `PUBLIC` row takes **no arguments**: trigger and event-trigger functions,
which cannot be called directly, plus the four RLS helpers
(`current_user_org_id`, `current_user_role`, `current_user_property_ids`,
`current_user_scoped_vendor_ids`) that every policy calls as the signed-in
user and which the query's own notes name as correct and necessary.

📌 `rls_auto_enable` is confirmed Supabase platform furniture — a zero-argument
event trigger. That closes the question left open at Stage 3.

The `anon, authenticated` group is the public application surface (`0062`):
token-hash-gated draft, attachment and submit, plus branding lookups by host
and slug. **No row shows the `0210` shape** — nothing taking a sender
reference or a ticket id is reachable by `anon`.

## Also observed

- `channel_routes` = 0 — WhatsApp and Telegram are not configured in
  production. Consistent with 5.5 and 5.6 being open; no notification will
  leave by either channel until they are.
- `payment_settings` = 0 — no organisation has payment settings of its own.
