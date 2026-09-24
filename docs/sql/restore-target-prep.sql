-- Prepare a SCRATCH database to receive an `npm run backup` dump.
--
--   createdb ipms_restore_drill
--   psql -d ipms_restore_drill -f docs/sql/restore-target-prep.sql
--   pg_restore --no-owner --no-privileges -d ipms_restore_drill <file>.dump
--   psql -d ipms_restore_drill -f docs/sql/restore-drill-check.sql
--
-- ⚠️ WHY THIS EXISTS — measured 24 Sept 2026 by building the full 321-migration
-- schema locally, dumping it exactly as `npm run backup` does, and restoring it.
--
-- `npm run backup` dumps `--schema=public` only. Restored into a plain
-- PostgreSQL WITHOUT this file, the restore reported 88 errors, and two of the
-- losses were silent in the only check the drill then prescribed:
--
--   • `leases_no_overlap` was NOT created — the exclusion constraint that makes
--     the database refuse a double-let. It needs `btree_gist`, and a
--     schema-scoped dump never carries extensions.
--   • the three foreign keys into `auth.users` were NOT created.
--
-- EVERY row count still matched the source. A drill comparing rows alone
-- would have certified that database as good.
--
-- With this file first: exactly one error (`schema "public" already exists`,
-- benign), and constraints identical to the source by type.
--
-- ⚠️ SAFE AGAINST A REAL SUPABASE PROJECT, deliberately. Every stub below is
-- created only when its schema is ABSENT. Supabase already has `auth` and
-- `storage`; run there, this file creates nothing but a missing extension.
-- An unconditional `create or replace function auth.uid()` would overwrite
-- Supabase's own and break every row-level policy in the database.

-- 1. Supabase's roles — named by 554 policies and grants in `public`.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

-- 2. The extensions a schema-scoped dump does not carry.
--    Without btree_gist, `leases_no_overlap` is silently lost.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- 3. Minimal `auth` — only where there is no real one.
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
    create table auth.users (id uuid primary key);
    execute 'create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$';
  end if;
end $$;

-- 4. Minimal `storage` — only where there is no real one.
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    create schema storage;
    create table storage.buckets (id text primary key);
    create table storage.objects (id uuid primary key default gen_random_uuid(),
                                  bucket_id text, name text, owner uuid);
    execute 'create function storage.foldername(name text) returns text[] language sql immutable as $f$ select string_to_array(name, ''/'') $f$';
  end if;
end $$;
