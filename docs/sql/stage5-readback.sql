-- Stage 5.10 step 3 — read back what Stage 5 wrote into production.
--
-- Paste into the Supabase SQL editor for the PRODUCTION project. Run each of
-- the three queries separately (the editor shows only the last result), and
-- commit all three outputs beside this file as
-- `docs/verify-runs/stage5-<date>-readback.md`.
--
-- Read-only. Nothing here writes, and it is safe to re-run at any time.
--
-- ⚠️ Why this exists: an update that silently matched 0 rows has happened
-- twice in this build, and "I set it" is a report, not a state. Every Stage 5
-- step that wrote a row is closed by this read-back, not by the report.
--
-- ⚠️ No credential is ever SELECTED here. `channel_routes.external_id` is the
-- webhook secret for both channels (0047) and `outbound_token` is the bot
-- token / 360dialog API key — pasting either into a result, a commit or a chat
-- is a leak. Both are reduced to present/absent and to a shared-with-another-
-- org check, which is the only question about them this step asks.
--
-- Like stage3-production-proof.sql, each query COMPUTES its verdict. Anything
-- other than every row reading OK is a stop.

-- ── 1. The orgs — identity, sender, domain (5.8) ──────────────────────────
--
-- B1: no two CLIENT orgs may share a sender, support or finance address. A
-- shared one tells a tenant of one brand that the other exists, and routes
-- their replies into the other's inbox.
--
-- The platform operator (`is_platform_operator`, OE Group) is exempt from the
-- sharing check, deliberately: its mail reaches only its own staff. An org the
-- operator provisions is invited AS that org (`app/orgs/actions.ts` passes the
-- new org's id to `sendEmail`), never as the operator. First run on production,
-- 25 Sept 2026, flagged TFML for sharing its sender with OE Group — true, and
-- not B1.
--
-- A missing custom_domain is a CHECK, not a STOP: an org without one is reached
-- through the neutral platform address, which breaks no rule. It is a STOP only
-- for the two brands, whose domains 5.8 bound.
select o.slug,
       o.name,
       o.delivery_brand,
       o.is_platform_operator,
       o.custom_domain,
       o.email_from_name,
       o.email_from_address,
       o.support_email,
       o.finance_email,
       o.uses_platform_gateway,
       case
         when o.custom_domain is null and o.delivery_brand in ('TFML','OEA')
                                                         then 'STOP — a brand org with no custom_domain (5.8)'
         when o.email_from_address is null               then 'STOP — no sender address'
         when o.support_email is null                    then 'CHECK — no support address (the privacy notice falls back to it when DPO_CONTACT_EMAIL is unset)'
         when not o.is_platform_operator
          and exists (select 1 from orgs x
                       where x.id <> o.id and not x.is_platform_operator
                         and (lower(x.email_from_address) = lower(o.email_from_address)
                           or lower(x.support_email)      = lower(o.support_email)
                           or lower(x.finance_email)      = lower(o.finance_email)
                           or lower(x.custom_domain)      = lower(o.custom_domain)))
                                                         then 'STOP — an address or domain is shared with another client org (B1)'
         when o.custom_domain is null                    then 'CHECK — no custom_domain; reached through the platform address'
         else 'OK'
       end as verdict
  from orgs o
 order by o.slug;

-- ── 2. The channels — Telegram (5.6) and WhatsApp (5.5) ───────────────────
--
-- Expected at go-live: one telegram row per client org, each with its own
-- outbound token. WhatsApp: one row per org once 5.5 is done, none before.
select o.slug,
       r.channel,
       r.label,
       r.created_at::date                          as registered,
       (r.outbound_token is not null)              as can_send,
       length(r.external_id)                       as secret_length,
       case
         when r.outbound_token is null
           then 'STOP — inbound only; this org cannot answer on this channel'
         when length(r.external_id) < 32
           then 'STOP — webhook secret shorter than 32 characters'
         when exists (select 1 from channel_routes x
                       where x.id <> r.id and x.org_id <> r.org_id
                         and x.outbound_token = r.outbound_token)
           then 'STOP — outbound credential shared with another org (decision 47)'
         when (select count(*) from channel_routes x
                where x.org_id = r.org_id and x.channel = r.channel) > 1
           then 'CHECK — more than one route for this org on this channel'
         else 'OK'
       end as verdict
  from channel_routes r
  join orgs o on o.id = r.org_id
 order by r.channel, o.slug;

-- ── 3. The money path — client-funds accounts (1.9) ───────────────────────
--
-- Empty new accounts carry NO opening entry, by design: record_opening_balance
-- refuses a zero total, and the banking screen says "Brand-new empty account?
-- Leave this". So for an empty account `opening_entry_id` NULL is correct, and
-- the ledger balance must be exactly zero. A non-zero ledger balance before
-- the first real payment means something was posted that should not have been.
select o.slug,
       b.label,
       b.purpose,
       b.currency,
       b.active,
       (b.ledger_account_id is not null)           as linked_to_ledger,
       (b.published_account_number is not null)    as shown_to_payers,
       b.opening_date,
       coalesce((select sum(p.amount) from ledger_postings p
                  where p.account_id = b.ledger_account_id), 0) as ledger_balance,
       case
         when not b.active then 'NOTE — inactive account'
         when b.ledger_account_id is null
           then 'STOP — not linked to a ledger account'
         when (select count(*) from bank_accounts x
                where x.org_id = b.org_id and x.purpose = 'client_funds' and x.active) <> 1
           then 'STOP — not exactly one live client-funds account for this org'
         when b.opening_entry_id is null
          and coalesce((select sum(p.amount) from ledger_postings p
                         where p.account_id = b.ledger_account_id), 0) <> 0
           then 'STOP — no opening entry, but the ledger is not at zero'
         when b.published_account_number is null
           then 'CHECK — payers are not shown an account number to transfer to'
         else 'OK'
       end as verdict
  from bank_accounts b
  join orgs o on o.id = b.org_id
 order by o.slug, b.purpose;
