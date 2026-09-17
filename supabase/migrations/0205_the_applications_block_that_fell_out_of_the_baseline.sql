-- The applications block fell out of the B7 baseline, and took audit 0729b-S1
-- with it.
--
-- `0153` rewrote `seed_b7_permissions` to give the two new payment roles their
-- baseline. In doing so it re-typed the whole CASE rather than adding a branch
-- to it, and the four `applications.*` lines did not survive the retyping:
--
--   BEFORE (0082, the last version that was right)   AFTER (0153 -> 0203)
--   ----------------------------------------------   --------------------
--   executive         applications.review_all        -- dropped --
--   executive         applications.approve           -- dropped --
--   facility_manager  applications.recommend         -- dropped --
--   finance_approver  applications.approve           -- dropped --
--   regional_manager  applications.recommend         applications.review_all
--
-- The last line is the one that matters most. `applications.review_all` is
-- defined as "read every tenant application in the organisation, not only
-- those for properties they are attached to", and granting it to a role
-- defined by its region is **audit 0729b finding S1 (High), reinstated** --
-- the finding `0077` was written to close, closed, and explained at length in
-- its own header. On every organisation created since `0153`, a regional
-- manager has been able to read every applicant's identity documents in the
-- organisation, and to rewrite the document requirements of every property in
-- it.
--
-- The three dropped grants are the other half. `applications.recommend` and
-- `applications.approve` are the two tiers of decision 10's human review --
-- the NDPA Art. 37 control the board locked. With neither granted to anybody
-- but `admin`, a new organisation cannot run a two-tier review at all: the
-- FM/PM who is supposed to recommend is refused by
-- `record_application_recommendation` ("you do not hold
-- applications.recommend"), and the only role left holding both tiers is the
-- one role that should never be the whole chain by itself.
--
-- 📌 The failure mode is worth naming, because it is the third time in this
-- build (see `0184`/`0185`) that a correct fix was undone by a later migration
-- RE-TYPING the function it lived in rather than amending it.
-- `seed_b7_permissions` has now been redefined eleven times; each redefinition
-- silently inherits responsibility for every earlier decision in the body, and
-- nothing checked that it still carried them. `verify-audit-0729b` DID assert
-- S1, and has been failing since `0153` -- the assertion was right and was not
-- being read. Section 4 moves that assertion into the migration itself, and
-- widens it from S1 to the whole applications block.

-- ---- 1. The baseline, with the applications block restored ----------------
--
-- Identical to `0203`'s version except for the applications lines. Both FM and
-- PM recommend, because decision 18 made them peers holding identical grants;
-- `0082` predates that split and named only `facility_manager`.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when cap.key = 'tickets.assign_without_review' then false
        when cap.key = 'training.read' then false

        when r = 'admin' then true

        -- Oversight sees everything finance sees (decision 9), and B7 gives the
        -- MD / Managing Partner an org-wide row. Restored from 0082.
        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned',
          'applications.review_all', 'applications.approve'
        )

        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- ⚠️ `applications.review_all` is NOT on this list and must never be
        -- added to it. Every capability here is bounded by the property
        -- scoping in the policy that reads it; that one is not, which is the
        -- whole of audit 0729b-S1. A regional manager reaches their own
        -- region's applications through
        -- `property_id in (select current_user_property_ids())`, which expands
        -- the node subtree -- scoping does the work correctly.
        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend'
        )

        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r in ('facility_manager', 'property_manager')

        -- Tier one recommends, tier two decides: two capabilities, never one
        -- person (decision 10, `0082`).
        when cap.key = 'applications.recommend'
          then r in ('facility_manager', 'property_manager')
        when cap.key = 'applications.approve' then r = 'finance_approver'

        when cap.key = 'vendors.read'
          then r in ('facility_manager', 'property_manager', 'finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read'
          then r in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 for training.read, +0205 restoring the applications block 0153 dropped). A capability not named here falls to `else false` -- decision 7''s "B7 silent means OFF".';

-- ---- 2. The revoke --------------------------------------------------------
--
-- Unconditional, exactly as `0077` did it, and for the same reason: this is a
-- High finding, and narrowing access is never the unsafe direction. An operator
-- who genuinely wants a regional manager reading the whole organisation's
-- applicant files can grant it again deliberately, which is a different act
-- from inheriting it from a seed that should never have offered it.
update role_permissions
   set granted = false, set_at = now()
 where role = 'regional_manager'
   and capability = 'applications.review_all'
   and granted;

-- ---- 3. The restores ------------------------------------------------------
--
-- ⚠️ Only where `set_by is null`. These three grants WIDEN access, so unlike
-- the revoke above they must not overwrite a decision a person actually made.
-- `set_by` is null on every row written by `seed_b7_permissions` and non-null
-- on every row moved through `set_role_permission`, so the condition reads
-- exactly "this row has only ever been a default". Confirmed 27 Aug 2026: no
-- operator has ever set an `applications.*` row on any world, so in practice
-- this reaches every affected organisation -- but the condition is the rule,
-- not the count.
update role_permissions
   set granted = true, set_at = now()
 where set_by is null
   and not granted
   and (
        (role = 'executive'        and capability in ('applications.review_all',
                                                      'applications.approve'))
     or (role = 'finance_approver' and capability = 'applications.approve')
     or (role in ('facility_manager', 'property_manager', 'regional_manager')
                                   and capability = 'applications.recommend')
   );

-- ---- 4. The guard, so the next retyping cannot lose it silently -----------
--
-- A PL/pgSQL body is not checked against anything until it runs, and "did this
-- rewrite keep every earlier decision" has never been a question a migration
-- could ask. It can be asked of the ROWS the function produces -- so a probe
-- org is seeded, inspected and removed inside this migration's own
-- transaction. If a future redefinition drops the block again, the migration
-- that does it fails to apply rather than shipping.
do $guard$
declare
  v_org uuid;
  v_bad text;
begin
  insert into orgs (name, delivery_brand) values ('__b7_probe__', 'direct')
  returning id into v_org;

  perform seed_b7_permissions(v_org);

  select string_agg(format('%s must %s %s', t.role, t.expect, t.capability), '; ')
    into v_bad
    from (
      select rp.role::text as role, rp.capability, 'hold' as expect
        from role_permissions rp
       where rp.org_id = v_org and not rp.granted
         and (rp.role, rp.capability) in (
              ('executive'::user_role,        'applications.review_all'),
              ('executive'::user_role,        'applications.approve'),
              ('finance_approver'::user_role, 'applications.approve'),
              ('facility_manager'::user_role, 'applications.recommend'),
              ('property_manager'::user_role, 'applications.recommend'))
      union all
      select rp.role::text as role, rp.capability, 'NOT hold' as expect
        from role_permissions rp
       where rp.org_id = v_org and rp.granted
         and (rp.role, rp.capability) in (
              ('regional_manager'::user_role, 'applications.review_all'))
    ) t;

  delete from role_permissions where org_id = v_org;
  delete from orgs where id = v_org;

  if v_bad is not null then
    raise exception
      'seed_b7_permissions no longer states the applications block: %', v_bad;
  end if;
end;
$guard$;
