-- B7 is computed in one place, and the badge stops lying about it.
--
-- The permission matrix carries a "differs from B7" badge whose whole job is to
-- make deliberate drift from the board-approved baseline visible. It was
-- comparing against a SECOND copy of B7, hand-maintained in TypeScript
-- (`app/dashboard/settings/permissions/actions.ts`), and that copy had fallen
-- five changes behind the database:
--
--   • `records.export` (0233) was absent, so the map fell through to
--     `role === admin -> true` and the badge reported an administrator as
--     MATCHING B7 on a capability the seed sets false for everyone.
--   • `hierarchy.write`, `sc.manage` and `leases.write` for the regional
--     manager (0236) were absent, so a correct baseline badged as drift.
--   • `vendors.recommend` / `vendors.approve` (0238) were absent, same.
--   • ⚠️ Worst: the TS copy claimed B7 gave the regional manager
--     `applications.review_all`. The database has never granted it, and
--     `0205`s own comment says it "must never be added" because it is the one
--     capability in that arm NOT bounded by property scoping. The badge was
--     advertising an unbounded org-wide read as the approved baseline.
--
-- 📌 This is decision 24s "two copies of one list will disagree, and did",
-- one table over -- and the fix is the same one: delete the copy. `b7_grants()`
-- below holds the CASE, `seed_b7_permissions` calls it instead of restating
-- it, and `b7_baseline()` hands the same answer to the screen. One expression,
-- three consumers, no way for them to drift.
--
-- The CASE body is `pg_get_functiondef`s, with `cap.key` and `r` rebound to the
-- two parameters and nothing else touched -- `0183`s rule for the fourth time.

create or replace function b7_grants(p_role user_role, p_capability text)
returns boolean
language sql immutable set search_path = public as $fn$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        when p_role = 'admin' then true

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          -- 0238. They hold BOTH, and that is not a contradiction: the
          -- maker-checker in approve_vendor_application is per application and
          -- per person, so a regional manager who recommended one must hand it
          -- to a colleague or the administrator. Holding both is what lets a
          -- region run without an administrator in the loop for every vendor;
          -- it is not permission to do both on the same application.
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         -- 0238: the FM/PM put a contractor forward. They do
                         -- NOT hold vendors.approve, which is the whole change.
                         'vendors.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')
        when p_capability = 'sc.manage'    then p_role = 'finance_approver'
        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$fn$;

comment on function b7_grants is
  'Whether B7 -- the board-approved baseline -- grants one capability to one role. THE definition: seed_b7_permissions provisions from it and b7_baseline() reports it, so the seeder and the "differs from B7" badge cannot disagree. Added by 0244 after a hand-maintained TypeScript copy fell five changes behind and badged an unbounded capability as baseline.';

-- The seeder now states the loop and nothing about the rule.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  cap record;
  r user_role;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, b7_grants(r, cap.key))
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$fn$;

comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to. The rule itself lives in b7_grants() since 0244; this states only which roles and capabilities to walk.';

-- What the screen reads, so it compares against the same expression the
-- database provisions from rather than a copy of it.
create or replace function b7_baseline()
returns table (role user_role, capability text, granted boolean)
language sql stable security definer set search_path = public as $fn$
  select r.role, c.key, b7_grants(r.role, c.key)
    from (select unnest(array['tenant','vendor','fm_ops_staff','facility_manager',
                              'property_manager','finance_approver','property_owner',
                              'admin','viewer','executive','regional_manager',
                              'payment_audit_approver','payment_approver']::user_role[]) as role) r
   cross join capabilities c
   where not c.locked;
$fn$;

-- 0204/0209/0210/0231 revoke, applied on the way in rather than four
-- migrations later. b7_baseline takes no caller-supplied argument and leaks
-- nothing org-specific, but it is still not anon's to read.
revoke all on function b7_grants(user_role, text) from public;
revoke execute on function b7_grants(user_role, text) from anon;
grant execute on function b7_grants(user_role, text) to authenticated;
revoke all on function b7_baseline() from public;
revoke execute on function b7_baseline() from anon;
grant execute on function b7_baseline() to authenticated;

comment on function b7_baseline is
  'The whole B7 baseline as rows, for the permission matrix to compare against. Same b7_grants() the seeder uses -- 0244 exists so those two can never disagree again.';
