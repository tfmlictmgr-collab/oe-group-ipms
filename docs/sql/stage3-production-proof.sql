-- Stage 3.4 and 3.6 — prove the production project is correctly shaped and empty.
--
-- Paste into the Supabase SQL editor for the PRODUCTION project, AFTER
-- `npm run migrate` has run and BEFORE anything else touches it. Commit the
-- output beside this file as `docs/verify-runs/stage3-<date>.md` — 3.6 asks
-- for the query AND its result, because a claim of emptiness with nothing
-- behind it is the thing this step exists to replace.
--
-- Read-only. Nothing here writes, and it is safe to re-run at any time.
--
-- ⚠️ Both queries are written to COMPUTE their verdict rather than lay out
-- numbers for a human to compare. Checking 7 buckets by eye at the end of a
-- cutover, against caps set across six migrations, is exactly the task people
-- get wrong while believing they got it right.

-- ── 3.4 — the seven buckets ────────────────────────────────────────────────
--
-- Expected values are pinned here from the migrations that set them:
--   org-logos             0015   PUBLIC BY DESIGN — brand marks on the sign-in page
--   application-documents 0062, capped by 0300
--   work-order-media      0106   25 MiB, images and video
--   vendor-documents      0164, lowered to 2 MiB by 0213
--   invoice-attachments   0140
--   payment-proofs        0281
--   payout-evidence       0289
--
-- A FULL JOIN, not a left join: a bucket that exists but is not expected is as
-- much a finding as one that is missing. Anything other than seven rows all
-- reading OK is a stop.
with expected(id, public, file_size_limit) as (
  values ('org-logos',             true,  null::bigint),
         ('application-documents', false, 10485760),
         ('work-order-media',      false, 26214400),
         ('vendor-documents',      false, 2097152),
         ('invoice-attachments',   false, 2097152),
         ('payment-proofs',        false, 5242880),
         ('payout-evidence',       false, 5242880)
),
checked as (
  select coalesce(e.id, b.id)                        as bucket,
         b.public                                    as actual_public,
         b.file_size_limit                           as actual_limit,
         coalesce(array_length(b.allowed_mime_types, 1), 0) as mime_types,
         case
           when b.id is null then '⛔ MISSING — the migration that creates it did not run'
           when e.id is null then '⛔ UNEXPECTED — a bucket no migration in this repo creates'
           when b.public is distinct from e.public
             then case when b.public then '⛔ PUBLIC — reachable by URL without a signed link'
                       else '⛔ PRIVATE — org-logos must be public or sign-in pages lose their brand mark' end
           when b.file_size_limit is distinct from e.file_size_limit
             then format('⛔ LIMIT %s, expected %s', coalesce(b.file_size_limit::text, 'none'),
                                                     coalesce(e.file_size_limit::text, 'none'))
           when e.id <> 'org-logos' and coalesce(array_length(b.allowed_mime_types, 1), 0) = 0
             then '⛔ NO MIME ALLOW-LIST — anything can be uploaded'
           else 'OK'
         end                                         as verdict
    from expected e
    full join storage.buckets b on b.id = e.id
)
-- Failures first. The ordering is a CTE away rather than inline because an
-- output alias cannot be used inside an ORDER BY expression — caught by
-- running this against a real PostgreSQL 16 rather than by reading it.
select * from checked
 order by (verdict = 'OK'), bucket;

-- ── 3.6 — emptiness, by query ──────────────────────────────────────────────
--
-- Enumerated from the catalogue rather than from a hand-written list of
-- tables. A list would be correct on the day it was written and silently
-- incomplete by the next migration, and "the tables I remembered to check are
-- empty" is not the claim 3.6 wants.
--
-- The only non-zero counts permitted are what the migrations themselves
-- create: the operator org (0088), the permission baseline, and the chart of
-- accounts. Read the rows — do not scan for zeroes. A non-zero count in any
-- table naming tenants, tickets, leases, invoices, payments or people means
-- production is NOT empty and something reached it before cutover.
select t.table_name,
       (xpath('/row/c/text()', x))[1]::text::bigint as row_count
  from (
    select c.relname as table_name,
           query_to_xml(format('select count(*) as c from public.%I', c.relname),
                        false, true, '') as x
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
  ) t
 order by row_count desc, table_name;

-- ── The schema itself ──────────────────────────────────────────────────────
--
-- The migration ledger is the answer to "did 3.3 actually finish", and the
-- highest name in it must match the highest file in supabase/migrations.
select count(*) as migrations_applied, max(name) as highest
  from _migrations;

-- ── Who can execute the SECURITY DEFINER functions ─────────────────────────
--
-- Added 21 Sept 2026, after `0214` refused to apply to the fresh production
-- database because four functions `0210` created were still EXECUTE-able by
-- PUBLIC. See `0213a` for the mechanism. The question that failure raises is
-- "are there others", and a static read of the migration files cannot answer
-- it: it cannot tell a genuine leak from one a later blanket revoke already
-- closed, and it cannot tell a client-callable function from a trigger
-- function, for which PUBLIC EXECUTE means nothing at all. Only the live
-- database knows.
--
-- ⚠️ Unlike the two queries above, this one does NOT compute a verdict, and
-- pretending otherwise would be worse than useless. Some rows here are
-- correct and necessary — the RLS helpers (`current_user_org_id`,
-- `current_user_role`, `has_permission`, `current_user_property_ids`) are
-- SECURITY DEFINER *and* meant to be callable by `authenticated`, because
-- every policy in the database calls them as the signed-in user. Trigger
-- functions are harmless for the same reason nobody can usefully call them.
--
-- What to actually look for, row by row:
--
--   • `PUBLIC` or `anon` on anything taking an org id, a sender reference or
--     a ticket id as an ARGUMENT. Those are the `0210` shape: SECURITY
--     DEFINER means RLS never runs, and a caller-supplied org id means
--     nothing confines them to one brand (B1).
--   • `anon` on anything that WRITES. `remember_conversation_state` was the
--     example that mattered — an anonymous caller could point any sender's
--     conversation at any ticket.
--   • anything you cannot immediately explain. The four in `0210` were
--     explicable for four months.
--
-- Joined on `specific_name` rather than the bare name so overloads stay
-- distinct: `remember_conversation_state` exists with both 7 and 8 arguments,
-- and only one of them was ever the problem.
select p.proname                                            as function,
       pg_get_function_identity_arguments(p.oid)            as arguments,
       string_agg(distinct g.grantee, ', ' order by g.grantee) as executable_by
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join information_schema.routine_privileges g
    on g.routine_schema = n.nspname
   and g.specific_name  = p.proname || '_' || p.oid
 where n.nspname = 'public'
   and p.prosecdef                       -- SECURITY DEFINER only
   and g.privilege_type = 'EXECUTE'
   and g.grantee in ('anon', 'authenticated', 'PUBLIC')
 group by p.proname, p.oid
 order by (string_agg(distinct g.grantee, ',') like '%PUBLIC%') desc,
          (string_agg(distinct g.grantee, ',') like '%anon%') desc,
          p.proname;
