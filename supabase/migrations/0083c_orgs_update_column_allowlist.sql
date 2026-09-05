-- The real fix. `0083b`'s column-level revoke did nothing, and could not have:
-- **`REVOKE UPDATE (col) ON t FROM r` only removes a column-specific grant — it
-- cannot override a table-level `UPDATE` grant, which implicitly covers every
-- column.** `authenticated` and `anon` both hold the blanket table-level UPDATE
-- Supabase grants by default, so the column revoke had nothing to bite on;
-- `has_column_privilege('authenticated', 'orgs', 'deleted_at', 'UPDATE')` still
-- returned true after it ran, and the suite's direct-PATCH check still succeeded.
--
-- Confirmed live before writing this, not assumed from the manual.
--
-- The pattern that actually works is the one already used for
-- `tenant_applications.sensitive` (0070) and `.resume_token_hash` (0081): revoke
-- the table-level grant entirely, then grant UPDATE on an explicit allowlist of
-- columns. A column left off the list is unwritable by construction, not by a
-- revoke that a future table-level grant could silently re-cover.
--
-- Three columns are excluded, not one:
--   • `deleted_at`   — the subject of this fix; retire_org()/unretire_org() only
--   • `is_platform_operator` — grants the single deliberate crossing of org
--     isolation in this system (0050). It had NO protection before this at all —
--     found while fixing the column beside it, worth closing in the same breath
--     rather than filed as a separate finding for the same root cause.
--   • `id`           — a primary key has no business being in an UPDATE payload
--
-- `retire_org`/`unretire_org` are owned by the table owner (`postgres`), so this
-- revoke never applies to them, exactly as intended.

revoke update on orgs from authenticated, anon;

grant update (
  name, delivery_brand, parent_org_id,
  theme_primary, theme_accent, theme_logo_text, logo_url, portal_name, tagline,
  support_email, support_phone, login_headline,
  vendor_applications_open, finance_email, it_email,
  email_from_name, email_from_address,
  tenant_applications_open
) on orgs to authenticated;

-- anon has no legitimate reason to UPDATE an org row at all — RLS already
-- refused it (current_user_role() is null for anon), and now so does the grant
-- itself, which is one fewer thing to reason about.

comment on column orgs.deleted_at is
  'Retired. Not in the UPDATE column allowlist for authenticated/anon — retire_org()/unretire_org() write it as the table owner, and nothing else can (audit 0729d-M1; corrected here after both a non-working trigger and a non-working column-level revoke).';

comment on column orgs.is_platform_operator is
  'True for OE Group only. Not in the UPDATE column allowlist either — found unprotected while fixing deleted_at beside it. Changed only by direct migration/database access, never by application code.';
