-- A vendor is recommended by one desk and approved by another, and never by the
-- same pair of hands.
--
-- Board, 30 Aug 2026. The tenant side has worked this way since `0082`:
-- `applications.recommend` is the first-tier read, `applications.approve` is the
-- independent second decision, and `record_application_approval` refuses the
-- recommender by name — "the person who recommended an application may not also
-- approve it". Decision 10's two-tier human review, enforced rather than
-- described.
--
-- ⚠️ The VENDOR side had none of it. `approve_vendor_application` tested
--
--     current_user_role() not in ('admin','facility_manager','property_manager',
--                                 'regional_manager')
--
-- and nothing else. So a facilities manager could approve a contractor
-- single-handed, there was no recommendation step for them to be the second
-- pair of hands ON, and the same person who brought a vendor in could admit
-- them. Vendors are the party this system pays; the tenant applicant is the
-- party it houses. Two-tier review on the second and one signature on the first
-- is exactly backwards.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
--   1. `vendors.recommend` — FM, PM, regional manager, admin. First-tier: read
--      the application and put it forward, or put it forward to be refused.
--      Never a final decision.
--   2. `vendors.approve` — regional manager and admin ONLY. The FM/PM lose the
--      decision they had, which is the point: they recommend to the desk above
--      them.
--   3. `vendor_applications` gains `recommended_by`, `recommended_at` and
--      `recommendation_notes`, mirroring `tenant_applications`.
--   4. `recommend_vendor_application()` moves an application to `under_review`
--      — a status the enum has carried since it was created and which nothing
--      has ever set.
--   5. `approve_vendor_application()` now requires `vendors.approve`, requires
--      the application to have BEEN recommended, and **refuses the
--      recommender**. Same sentence, same shape, same reason as the tenant twin.
--   6. `reject_vendor_application()` requires `vendors.approve` and the same
--      maker-checker where a recommendation exists — refusing is a final
--      decision too. It is deliberately still reachable from `submitted`: an
--      obviously bad application should not need a recommendation before
--      anybody may close it.
--
-- ── What deliberately does NOT change ─────────────────────────────────────
--
-- 📌 Vendor VISIBILITY stays org-wide for whoever holds `vendors.read`, and
-- narrowing it to `current_user_scoped_vendor_ids()` was considered and
-- rejected. That resolver answers "vendors already linked to a property I
-- hold" — so scoping the list to it would mean a manager could only ever see
-- contractors somebody had already attached to their building, and could never
-- find a new one to attach. That is decision 8's "a picker that can only select
-- is a dead end", exactly. A vendor is an organisation-level counterparty; the
-- REGION governs who may act, which is what the capability split above does,
-- not who may be looked at.
--
-- 📌 A vendor application carries no `property_id` and cannot, since the vendor
-- does not exist until it is approved. There is therefore no place clause to
-- put on these three functions, and inventing one would be a scope that is not
-- real. What bounds a regional manager here is the capability and the
-- maker-checker, not geography.

-- ── 1. The two capabilities ───────────────────────────────────────────────

-- `module` (not `category`) and it must match the existing vendor block, or
-- the two land in a section of the matrix editor of their own.
insert into capabilities (key, module, label, description, locked, sort_order)
values
  ('vendors.recommend', 'Vendors', 'Recommend vendor applications',
   'First-tier review: read a vendor application and put it forward for approval or refusal. Never a final decision.',
   false, 33),
  ('vendors.approve', 'Vendors', 'Approve or refuse vendors',
   'Second-tier, independent decision on a vendor application. Can never be the same person who recommended it.',
   false, 34)
on conflict (key) do nothing;

-- ── 2. The recommendation, recorded on the application ────────────────────

alter table vendor_applications
  add column if not exists recommended_by uuid references users(id),
  add column if not exists recommended_at timestamptz,
  add column if not exists recommendation_notes text;

-- ── 3. Putting one forward ────────────────────────────────────────────────

create or replace function recommend_vendor_application(
  p_application_id uuid,
  p_notes text
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare app vendor_applications%rowtype;
begin
  -- The tenant twin requires a reason of substance and so does this: a
  -- recommendation with no words is a rubber stamp, which is the thing
  -- decision 10 exists to prevent.
  if length(trim(coalesce(p_notes, ''))) < 10 then
    raise exception 'a recommendation has to say something -- state what you checked';
  end if;

  select * into app from vendor_applications
   where id = p_application_id for update;
  if app.id is null then raise exception 'application not found'; end if;
  if app.org_id is distinct from current_user_org_id() then
    raise exception 'application belongs to another organisation';
  end if;
  if not (select has_permission('vendors.recommend')) then
    raise exception 'you do not hold vendors.recommend';
  end if;
  if app.status in ('approved', 'rejected', 'withdrawn') then
    raise exception 'this application was already closed';
  end if;
  if app.status = 'under_review' then
    raise exception 'this application has already been recommended';
  end if;

  update vendor_applications
     set status = 'under_review',
         recommended_by = auth.uid(),
         recommended_at = now(),
         recommendation_notes = p_notes
   where id = p_application_id;
end;
$fn$;

revoke all on function recommend_vendor_application(uuid, text) from public;
revoke execute on function recommend_vendor_application(uuid, text) from anon;
grant execute on function recommend_vendor_application(uuid, text) to authenticated;

comment on function recommend_vendor_application is
  'First-tier vendor review (0238). Requires vendors.recommend and a stated reason; moves the application to under_review and records who put it forward. Never a final decision -- approve_vendor_application refuses this same person.';

-- ── 4. The decision, by someone else ──────────────────────────────────────

create or replace function approve_vendor_application(
  p_application_id uuid,
  p_notes text default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  app vendor_applications%rowtype;
  v_new_vendor uuid;
begin
  select * into app from vendor_applications where id = p_application_id for update;
  if app.id is null then
    raise exception 'application not found';
  end if;
  if app.org_id is distinct from current_user_org_id() then
    raise exception 'application belongs to another organisation';
  end if;

  -- ⚠️ Was a role list admitting the FM/PM. It is now the capability, and the
  -- FM/PM do not hold it: they recommend to the regional manager or the
  -- administrator, who decides.
  if not (select has_permission('vendors.approve')) then
    raise exception 'you do not hold vendors.approve -- an application is recommended by the FM/PM and approved above them';
  end if;

  if app.status = 'approved' then
    raise exception 'this application is already approved';
  end if;
  if app.status in ('rejected', 'withdrawn') then
    raise exception 'this application was already closed';
  end if;
  if app.status <> 'under_review' then
    raise exception 'this application has not been recommended by a first reviewer yet';
  end if;

  -- The control that actually prevents one person admitting their own
  -- contractor. Per application, per person -- not merely per role, which is
  -- the same shape 0142 uses for disbursement and 0082 for tenant review. It
  -- can legitimately refuse a regional manager who recommended it themselves;
  -- that is the rule working, and the answer is a second pair of hands.
  if app.recommended_by = auth.uid() then
    raise exception 'the person who recommended a vendor may not also approve it';
  end if;

  insert into vendors (org_id, name, service_category, contact_email, contact_phone,
                       status, approval_status, approved_by, approved_at)
  values (app.org_id, app.business_name, app.service_category, app.contact_email,
          app.contact_phone, 'active', 'approved', auth.uid(), now())
  returning id into v_new_vendor;

  update vendor_applications
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         decision_notes = p_notes, vendor_id = v_new_vendor
   where id = p_application_id;

  return v_new_vendor;
end;
$fn$;

comment on function approve_vendor_application is
  'Second-tier vendor decision (0238). Requires vendors.approve -- held by the regional manager and the administrator, NOT the FM/PM -- requires the application to have been recommended, and refuses the recommender. Creates the vendor record.';

create or replace function reject_vendor_application(
  p_application_id uuid,
  p_notes text default null
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare app vendor_applications%rowtype;
begin
  select * into app from vendor_applications where id = p_application_id for update;
  if app.id is null then raise exception 'application not found'; end if;
  if app.org_id is distinct from current_user_org_id() then
    raise exception 'application belongs to another organisation';
  end if;
  if not (select has_permission('vendors.approve')) then
    raise exception 'you do not hold vendors.approve -- refusing an application is a final decision';
  end if;
  if app.status in ('approved', 'rejected', 'withdrawn') then
    raise exception 'this application was already closed';
  end if;
  -- Only where there IS a recommendation. Reachable from `submitted` on
  -- purpose: an obviously bad application should not need to be recommended
  -- before anybody may close it.
  if app.recommended_by is not null and app.recommended_by = auth.uid() then
    raise exception 'the person who recommended a vendor may not also refuse it';
  end if;

  update vendor_applications
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
         decision_notes = p_notes
   where id = p_application_id;
end;
$fn$;

comment on function reject_vendor_application is
  'Refusing a vendor application (0238). Requires vendors.approve and refuses the recommender, because refusing is a final decision too. Still reachable from `submitted` -- an obviously bad application should not need a recommendation first.';

-- ── 5. The baseline, rewritten from the live catalogue ────────────────────
--
-- 📌 `0236`'s lesson, one migration later: the body below is
-- pg_get_functiondef's, with the regional-manager list and the FM/PM list
-- extended and NOTHING else retyped.

create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
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
        when cap.key = 'records.export' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
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

        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         -- 0238: the FM/PM put a contractor forward. They do
                         -- NOT hold vendors.approve, which is the whole change.
                         'vendors.recommend')
          then r in ('facility_manager', 'property_manager')

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
$fn$;

comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 training.read, +0205 applications block, +0225 tenancy approval to the region, +0233 records.export, +0236 hierarchy/sc.manage/leases.write, +0238 the vendor recommend/approve split). A capability not named here falls to else false -- decision 7 "B7 silent means OFF".';

-- ── 6. Existing orgs ──────────────────────────────────────────────────────
--
-- The two new capabilities have no row anywhere yet, so this INSERTS rather
-- than updating: seed_b7_permissions is `on conflict do nothing`, and a
-- capability created after an org was provisioned would otherwise never reach
-- it. Every live org, both new keys, at the baseline the function above states.
insert into role_permissions (org_id, role, capability, granted)
select o.id, r.role, c.key,
       case
         when r.role = 'admin' then true
         when c.key = 'vendors.recommend'
           then r.role in ('facility_manager', 'property_manager', 'regional_manager')
         when c.key = 'vendors.approve'
           then r.role = 'regional_manager'
         else false
       end
  from orgs o
 cross join (select unnest(enum_range(null::user_role)) as role) r
 cross join (values ('vendors.recommend'), ('vendors.approve')) as c(key)
 where o.deleted_at is null
on conflict (org_id, role, capability) do nothing;
