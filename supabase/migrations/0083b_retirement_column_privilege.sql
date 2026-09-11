-- The trigger from 0083 does not work, and could not have.
--
-- `orgs_block_direct_retirement` keyed its check on `auth.uid() is not null` to
-- distinguish a human session from a trusted write. But `SECURITY DEFINER`
-- changes which ROLE Postgres checks privileges as; it does not touch
-- `auth.uid()`, which reflects the JWT on the calling session regardless. So the
-- trigger fired inside `retire_org` too and blocked its own UPDATE — caught by
-- the suite on its very first run: `retire_org` raised the exact message meant
-- for a direct PATCH.
--
-- The correct mechanism is the one already used for `tenant_applications.sensitive`
-- and `resume_token_hash` (0070, 0081): a column-level privilege revoke. Postgres
-- checks column privileges independently of, and before, any RLS policy — a
-- brand admin keeps ordinary UPDATE on their org row (theming, the intake
-- switch), and `deleted_at` alone is carved out of it, for every role except the
-- table owner. `retire_org`/`unretire_org` are owned by `postgres` (this
-- database's superuser, the same owner as every other SECURITY DEFINER function
-- here), so the revoke never applies to them — no session flag, no trigger, no
-- special-casing needed.

drop trigger if exists orgs_no_direct_retirement on orgs;
drop function if exists orgs_block_direct_retirement();

revoke update (deleted_at) on orgs from authenticated, anon;

comment on column orgs.deleted_at is
  'Retired. UPDATE on this column is revoked from every role except the table owner — retire_org()/unretire_org() are what write it, and only they can, because a column-level revoke holds even where an RLS policy would otherwise permit the row (audit 0729d-M1, corrected from a non-working trigger).';
