-- Audit 0805, M1/M2/L1 — the three findings left open when the two HIGHs
-- were fixed (0107). None are urgent the way H1/H2 were, but all three are
-- real and none should stay unfixed longer than necessary.

-- ── M1 — Telegram's dedup key can collide ACROSS organisations ─────────────
--
-- 0105 added `chat_webhook_events`, unique on `(channel, event_id)`, to stop
-- a provider's own webhook retry from being reprocessed as a new message —
-- see 0105's own comment for the incident that motivated it. That was safe
-- for WhatsApp (Meta's `wamid` is globally unique across the whole network)
-- but not for Telegram: `update_id` is a small, per-bot sequential integer,
-- and this platform runs several bots (TFML, OEA, the POC). Two different
-- orgs' bots reaching the same small `update_id` in their own independent
-- sequences is not a remote edge case at low-to-moderate traffic — and when
-- it happens, the SECOND org's insert collides with the FIRST org's
-- already-recorded row, the handler logs "already handled" and returns 200,
-- and a genuinely new message from a different tenant, in a different
-- organisation, is silently dropped: no ticket, no reply, no error anywhere.
--
-- `org_id` was already a column on the table, and already populated by both
-- webhook routes before this insert runs (route resolution happens first;
-- an unrouted request never reaches the dedup insert at all) — it was simply
-- not part of the uniqueness key. Adding it is the whole fix: a redelivery of
-- the SAME event to the SAME org's bot is still caught (WhatsApp is
-- unaffected, since wamid was already unique on its own); two different
-- orgs sharing a small integer no longer collide at all.
drop index if exists chat_webhook_events_dedupe_uidx;
create unique index chat_webhook_events_dedupe_uidx
  on chat_webhook_events (channel, org_id, event_id);

comment on index chat_webhook_events_dedupe_uidx is
  'org_id is part of the key, not just a column (audit 0805-M1) -- WhatsApp wamid is globally unique so this changes nothing for it, but Telegram update_id is a small per-bot sequential integer that two different orgs bots WILL eventually collide on, and without org_id in the key that collision silently drops a real message as a false "already handled".';

-- ── M2 — `logo_url` had no shape at all, and this window gave it a public,
--    unauthenticated redirect surface ──────────────────────────────────────
--
-- `orgs.logo_url` has carried plain `text` since 0015 with no format check
-- anywhere — the only validation was in the application (`saveLogoUrl()`),
-- and `logo_url` sits on the `authenticated` UPDATE allowlist (0083c), so an
-- admin's own session writing directly against the table (not through the
-- app's save action) was never actually stopped by anything at the database
-- layer. Before this window that meant, at worst, a broken `<img src>` on the
-- org's own branding pages. `app/favicon.ico/route.ts` (added this window)
-- turns the same column into a public, unauthenticated 307 redirect on every
-- visit to a bound custom domain — a classic open-redirect shape, and the
-- domain doing the redirecting is one the visitor already trusts.
--
-- Both existing values in production match this shape exactly (checked
-- before adding the constraint, so this is not a guess at what "valid" looks
-- like): a Supabase Storage public object URL under the org's own prefix in
-- the org-logos bucket. The application's own check already enforces the
-- FULL prefix, including the org's own id (`saveLogoUrl()`); this is
-- deliberately a looser DB-level shape (the domain and the bucket path,
-- without the per-org prefix) — the database is the last line of defence
-- against ANY external URL ever landing here, not a duplicate of the
-- application's own more precise authorisation check.
alter table orgs add constraint orgs_logo_url_shape
  check (
    logo_url is null
    or logo_url ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/org-logos/'
  );

comment on column orgs.logo_url is
  'Must be a Supabase Storage public URL in the org-logos bucket (orgs_logo_url_shape, audit 0805-M2) -- the app additionally restricts writes to the caller''s own org prefix (saveLogoUrl()), but this is the DB-level guarantee that closes the open-redirect surface app/favicon.ico/route.ts turned this column into: nothing that is not our own storage can ever be stored here, regardless of which client writes it.';

-- ── L1 — retiring (or superseding) a rubric criterion left no audit trail ──
--
-- `audit_evaluation_criteria` fired on INSERT only. `retire_evaluation_
-- criterion()` does a bare UPDATE (active = false) -- no trigger, no record.
-- `edit_evaluation_criterion()` was ALSO under-audited in the same way,
-- slightly wider than the original finding: it inserts the new row
-- (audited) but then UPDATEs the OLD row (superseded_by, active = false) --
-- that second write fired nothing either. Neither is money or access
-- control, but the migration's own comment sets the rubric's ethos as "the
-- same as the ledger... corrections are reversing entries, never edits", and
-- an unaudited UPDATE on an append-mostly table is a narrower guarantee than
-- that. `log_audit()` already handles UPDATE generically (0014); the fix is
-- simply to let the trigger fire on it.
drop trigger if exists audit_evaluation_criteria on evaluation_criteria;
create trigger audit_evaluation_criteria after insert or update on evaluation_criteria
  for each row execute function log_audit('evaluation_criteria.write');
