-- 0299 — The approved-application clock starts when the TENANCY ends, and the
-- renewal chain decides when that is (20 Sept 2026).
--
-- `NDPA_COMPLIANCE_PACK.md` §5 has carried this line since the Day 12 review:
--
--     Approved applications | tenancy + 6 years | ⛔ has no job yet
--
-- It is the last open row in that table, and it is the same shape as the
-- finding the pack calls its own sharpest — "the 90-day purge was specified,
-- built, tested, and never ran". That one was fixed by scheduling the job that
-- already existed. This one is fixed here, and deliberately in the same way:
-- by making the mechanism that ALREADY WORKS apply to the second rule, rather
-- than by writing a second deletion path.
--
-- ── Why this migration deletes nothing ─────────────────────────────────────
--
-- `purge_expired_applications()` (0062) already nulls the PII and keeps the
-- anonymised stub. It fires on one condition and one only:
--
--     where purged_at is null and purge_after is not null and purge_after < now()
--
-- The 90-day rule works because `0082` SETS `purge_after` on rejection. The
-- 6-year rule has never worked because **nothing sets it on approval** — 0062's
-- own comment says so in as many words: "`purge_after` is deliberately not set
-- on approval; the 6-year clock runs from tenancy end". The missing piece was
-- never the deletion. It was the date.
--
-- So this migration adds the thing that computes and stamps that date. The
-- deletion stays where it is, in the one function that has been proven end to
-- end. Two retention rules, one irreversible code path.
--
-- 📌 And the stamp is safe on the day it is wrong. A date six years in the
-- future deletes nothing for six years, the job recomputes it on every run, and
-- `withdraw` below clears it the moment the tenancy turns out to still be
-- running. An error here has a six-year window in which to correct itself,
-- which is not a property a purge has.
--
-- ── What "the tenancy ended" means, and the trap in it ─────────────────────
--
-- ⚠️ **A renewal continues the same tenancy.** That is not a new rule invented
-- here — it is the rule `0181` settled for the admin fee, where the same
-- mistake had real money attached: a once-per-tenancy charge was being levied
-- once a year because the code read a LEASE where the decision said TENANCY.
--
-- `leases.application_id` names the lease a portal application produced.
-- `leases.renewed_from_lease_id` chains the renewals after it, and a renewal
-- does NOT carry the application id forward. So the naive query —
--
--     select end_date from leases where application_id = a.id
--
-- answers with the end of the FIRST lease, and would stamp a six-year clock on
-- a tenant who is still living there under their fourth renewal. The applicant
-- whose data this protects would be purged while they are still a tenant.
--
-- The chain is therefore walked forward, recursively, from every lease the
-- application produced. The tenancy has ended only when NO lease anywhere in
-- that closure is still `draft` or `active`; its end is the latest `end_date`
-- in the closure.
--
-- ── Applications with no lease at all ──────────────────────────────────────
--
-- An approved application need not have produced a lease: the offer may never
-- have been accepted (0263), or the lease may have been recorded on paper with
-- no `application_id`. Those have no tenancy, so they have no clock, and this
-- job cannot invent one — stamping them on `decided_at` would be a different
-- retention rule than the one the board locked.
--
-- They are NOT silently left behind, which is how the first version of this
-- policy failed. `approved_applications_without_tenancy()` counts them, the
-- scheduled job reports the number on every run, and a number that grows is a
-- question for the DPO rather than a silence.

-- ── Is this application's tenancy over, and when did it end? ───────────────
--
-- Returns NULL while the tenancy is live or unknown; the end date once it is
-- genuinely over. One resolver, so the job and the report cannot disagree
-- about what "ended" means (decision 8's rule).
create or replace function application_tenancy_ended_on(p_application_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain as (
    -- The leases this application itself produced.
    --
    -- ⚠️ `deleted_at is null` in BOTH arms. A soft-deleted lease is a
    -- retracted one (`leases` is soft-delete only — `block_hard_delete`,
    -- 0010), and counting it would be wrong in both directions: a retracted
    -- `active` lease would hold the chain open forever so the clock never
    -- starts, and a retracted late-ending one would push the end date out and
    -- delay the purge. Retention must follow the tenancy that actually
    -- happened.
    select l.id, l.status, l.end_date
      from leases l
     where l.application_id = p_application_id
       and l.deleted_at is null

    union

    -- Everything renewed from them, to any depth.
    select l.id, l.status, l.end_date
      from leases l
      join chain c on l.renewed_from_lease_id = c.id
     where l.deleted_at is null
  )
  select case
           -- No lease: no tenancy, so no clock. Counted separately, never
           -- stamped.
           when count(*) = 0 then null
           -- Still running, or not yet started. `renewed` is an ENDED lease
           -- whose successor is already in this closure, so it does not hold
           -- the chain open on its own.
           when count(*) filter (where status in ('draft', 'active')) > 0 then null
           else max(end_date)
         end
    from chain;
$$;

-- Nothing in the product calls this; it exists for the retention job and the
-- suite that holds it. Closed to everyone else rather than left reachable
-- through PostgREST because it is security definer and answers a question
-- about one named applicant's tenancy.
revoke all on function application_tenancy_ended_on(uuid) from public, anon, authenticated;
grant execute on function application_tenancy_ended_on(uuid) to service_role;

comment on function application_tenancy_ended_on(uuid) is
  'The date an approved application''s tenancy ended, following renewals through renewed_from_lease_id, or NULL while it is live or has no lease. The 6-year retention clock runs from this date (0299).';

-- ── The job: stamp the clock, and withdraw it if the tenancy resumes ───────
--
-- Returns (stamped, withdrawn) so the scheduled route can report both. Both
-- numbers matter: the first says retention is being applied, the second says
-- the safety net caught something.
create or replace function stamp_approved_application_retention()
returns table (stamped integer, withdrawn integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stamped   integer := 0;
  v_withdrawn integer := 0;
begin
  -- Stamping and withdrawing are the SAME update under one predicate: set
  -- purge_after to what the tenancy says it should be, whenever the row does
  -- not already say that. "Stamped" is that answer being a date; "withdrawn"
  -- is it being null. Written as one statement rather than two so the two can
  -- never disagree about a row, and so the recursive chain walk runs ONCE per
  -- application instead of once per predicate.
  with candidates as (
    select a.id,
           a.purge_after,
           application_tenancy_ended_on(a.id) as ended_on
      from tenant_applications a
     where a.status = 'approved'
       and a.purged_at is null
  ),
  changed as (
    update tenant_applications a
       -- `::timestamptz` stated rather than left to the implicit date →
       -- timestamptz conversion, so the stored instant does not depend on the
       -- session's TimeZone. Immaterial across six years, explicit anyway.
       set purge_after = case
                           when c.ended_on is null then null
                           else c.ended_on::timestamptz + interval '6 years'
                         end
      from candidates c
     where a.id = c.id
       -- ⚠️ `is distinct from` and not `<>`. `purge_after` is nullable, and
       -- `null <> x` is null, not true — a `<>` filter would silently skip
       -- every row that has never been stamped, which is every row this job
       -- exists to find.
       and a.purge_after is distinct from case
                                            when c.ended_on is null then null
                                            else c.ended_on::timestamptz + interval '6 years'
                                          end
    returning a.id, c.ended_on
  )
  select count(*) filter (where ended_on is not null)::integer,
         count(*) filter (where ended_on is null)::integer
    into v_stamped, v_withdrawn
    from changed;

  return query select v_stamped, v_withdrawn;
end;
$$;

revoke all on function stamp_approved_application_retention() from public, anon, authenticated;
grant execute on function stamp_approved_application_retention() to service_role;

comment on function stamp_approved_application_retention() is
  'Retention: sets purge_after = tenancy end + 6 years on approved applications whose tenancy has ended, and clears it again if a renewal reopened the chain. Deletes nothing — purge_expired_applications() (0062) is the only deletion path (0299).';

-- ── The population that has no clock, so it cannot go unnoticed ────────────
create or replace function approved_applications_without_tenancy()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from tenant_applications a
   where a.status = 'approved'
     and a.purged_at is null
     and not exists (
           select 1 from leases l
            where l.application_id = a.id
              and l.deleted_at is null
         );
$$;

revoke all on function approved_applications_without_tenancy() from public, anon, authenticated;
grant execute on function approved_applications_without_tenancy() to service_role;

comment on function approved_applications_without_tenancy() is
  'Approved applications that produced no lease, so the 6-year clock cannot start. Reported by the retention job every run: a number that grows is a question for the DPO, not a silence (0299).';
