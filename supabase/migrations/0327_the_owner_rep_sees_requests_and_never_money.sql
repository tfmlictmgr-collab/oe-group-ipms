-- The Owner Rep: third-party oversight on a property owner's behalf
-- (requested 9 Oct 2026; enum values added by 0325).
--
-- What the role is, as decided with the requester:
--   • attached to the properties they represent, as relation `representative`;
--   • sees EVERY service request on those properties — unlike a landlord, who
--     sees only what they raised (decision 19) — and may raise one there;
--   • sees the properties, their units, the asset register and request
--     analytics for them;
--   • NO money, anywhere, by any switch: no rent, no service charge, no
--     tenancy terms, no statements, no ledger, no payments, no asset costs;
--   • no executive function: approves, assigns, closes and invites nothing;
--   • every permission it holds is a switch on the operator's matrix, and the
--     baseline is the most it can ever hold.
--
-- ── Why the place resolver is not narrowed ─────────────────────────────────
-- `current_user_property_ids()` does not filter on relation, so an Owner Rep's
-- properties come back from it exactly as a manager's do. Decision 8 forbids a
-- second resolver, and decision 19 records the right fix for this shape: the
-- resolver is right, each CONSUMER states which roles it is for. Every policy,
-- view and function that reads the resolver was read for this migration
-- (26 policies, 3 views, 29 functions on staging, 9 Oct 2026):
--   • role- or capability-gated already, so an Owner Rep reaches nothing
--     through them: the ledger and collection policies (property_finance_roles),
--     every write policy (sc.manage, leases.write, assets.write, applications.*),
--     raise_work_order, the offline-payment and invitation helpers;
--   • gated below by a switch: properties, units, tickets;
--   • refused below, unconditionally: rent charges, service charges and their
--     budgets, leases and lease notices (so rent_roll and tenancy_schedule, both
--     security_invoker, follow), tenancy applications and their document
--     findings, the asset table itself (it carries purchase, replacement and
--     insured values), property_statement(_lines), the two payment-request
--     creators, archived_assets, find_asset_by_identifier and
--     contest_document_finding.
-- `scripts/verify-owner-representative.mjs` enumerates the live consumers of
-- the resolver against this list, so a new one fails the suite until somebody
-- has decided what an Owner Rep may see through it.
--
-- ── Why "no money" is held in has_permission, not only in the baseline ─────
-- Decision 7 lets the operator switch any unlocked capability for any role.
-- Granting this role `leases.read` or `sc.read_all` would put money in front of
-- it through policies that ask only the capability. So has_permission() itself
-- answers false for an Owner Rep on anything that is not one of its own
-- `owner_rep.*` switches, and set_role_permission refuses to record such a
-- grant. A row written by some other path still grants nothing.
--
-- Rebuilt from the live catalogue through swaps that refuse unless they match
-- exactly once (0183), CR-free on both sides (0317), with grants asserted
-- unchanged.

set local lock_timeout = '5s';

-- ── 0. Swap helper (this transaction only) ─────────────────────────────────
create or replace function pg_temp.swap_fn(p_fn regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare
  d text;
  acl_before text;
  o text := replace(p_old, E'\r', '');
  n text := replace(p_new, E'\r', '');
begin
  select replace(pg_get_functiondef(p.oid), E'\r', ''), p.proacl::text
    into d, acl_before from pg_proc p where p.oid = p_fn;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0327: % — expected the text to swap exactly once', p_fn;
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = p_fn) is distinct from acl_before then
    raise exception '0327: % — grants changed by the rebuild', p_fn;
  end if;
end $$;

-- ── 1. Who is asking ───────────────────────────────────────────────────────
create or replace function caller_is_owner_rep()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(current_user_role() = 'owner_representative'::user_role, false);
$$;

revoke all on function caller_is_owner_rep() from public, anon;
grant execute on function caller_is_owner_rep() to authenticated, service_role;

comment on function caller_is_owner_rep() is
  'True when the signed-in caller is an Owner Rep. Used by the policies and functions that state what that role may see (0327).';

-- ── 2. Rank and onboarding ─────────────────────────────────────────────────
-- 18: below a landlord (20), above the read-only observer (15). An FM/PM may
-- therefore invite one (strictly below their 50) onto a property they hold,
-- as they may a landlord; a regional manager may not (decision 42's list is a
-- list), and an administrator may (enum_range).
select pg_temp.swap_fn('public.role_rank(user_role)'::regprocedure,
$o$           when 'viewer'                 then 15$o$,
$n$           when 'owner_representative'   then 18
           when 'viewer'                 then 15$n$);

-- ── 3. The switches ────────────────────────────────────────────────────────
insert into capabilities (key, module, label, description, locked, sort_order) values
  ('owner_rep.properties', 'Owner Rep', 'See the properties they represent',
   'Owner Rep only. The properties they are attached to and their units. Off, they see none of them. Never any money.',
   false, 95),
  ('owner_rep.requests_read', 'Owner Rep', 'See every request on those properties',
   'Owner Rep only. Every service request on the properties they represent and its progress, whoever raised it. Off, they see only the requests they raised.',
   false, 96),
  ('owner_rep.requests_raise', 'Owner Rep', 'Raise requests on those properties',
   'Owner Rep only. Raise a service request against a property they represent. They never assign, close or rate one.',
   false, 97),
  ('owner_rep.assets', 'Owner Rep', 'See the asset register of those properties',
   'Owner Rep only. The asset register of the properties they represent, without purchase, replacement or insured values.',
   false, 98),
  ('owner_rep.analytics', 'Owner Rep', 'Request analytics for those properties',
   'Owner Rep only. Volume, completion and response times of the requests they can see. No financial figures.',
   false, 99)
on conflict (key) do nothing;

-- ── 4. The baseline ────────────────────────────────────────────────────────
-- Placed first in the CASE: the role's arm is a closed answer (its own
-- switches, nothing else), and the switches mean nothing for any other role —
-- including an administrator, who is not shown holding them.
select pg_temp.swap_fn('public.b7_grants(user_role, text)'::regprocedure,
$o$  select case
        when p_capability = 'tickets.assign_without_review' then false$o$,
$n$  select case
        -- 0327. The Owner Rep holds its own switches and nothing else, and its
        -- switches mean nothing for anyone else.
        when p_role = 'owner_representative' then p_capability like 'owner\_rep.%'
        when p_capability like 'owner\_rep.%' then false

        when p_capability = 'tickets.assign_without_review' then false$n$);

select pg_temp.swap_fn('public.b7_baseline()'::regprocedure,
$o$'payment_audit_approver','payment_approver']::user_role[]$o$,
$n$'payment_audit_approver','payment_approver',
                              'owner_representative']::user_role[]$n$);

select pg_temp.swap_fn('public.seed_b7_permissions(uuid)'::regprocedure,
$o$'payment_audit_approver','payment_approver']::user_role[]$o$,
$n$'payment_audit_approver','payment_approver',
                             'owner_representative']::user_role[]$n$);

-- ── 5. No money by any switch ──────────────────────────────────────────────
select pg_temp.swap_fn('public.has_permission(text)'::regprocedure,
$o$        and rp.capability = p_capability),$o$,
$n$        and rp.capability = p_capability
        -- 0327. An Owner Rep holds its own switches and nothing else, whatever
        -- a role_permissions row says.
        and (rp.role <> 'owner_representative' or rp.capability like 'owner\_rep.%')),$n$);

select pg_temp.swap_fn('public.my_capabilities()'::regprocedure,
$o$     and rp.granted;$o$,
$n$     and rp.granted
     and (rp.role <> 'owner_representative' or rp.capability like 'owner\_rep.%');$n$);

select pg_temp.swap_fn('public.set_role_permission(uuid, user_role, text, boolean)'::regprocedure,
$o$  if v_caller is not null then
    select o.is_platform_operator into v_is_operator$o$,
$n$  -- 0327. Refused rather than recorded: a grant that has_permission would
  -- ignore is a matrix that lies about what a person can reach.
  if p_granted and p_role = 'owner_representative' and p_capability not like 'owner\_rep.%' then
    raise exception 'an Owner Rep holds only its own switches — % cannot be granted to it', p_capability;
  end if;
  if p_granted and p_role <> 'owner_representative' and p_capability like 'owner\_rep.%' then
    raise exception '% is an Owner Rep switch and means nothing for any other role', p_capability;
  end if;

  if v_caller is not null then
    select o.is_platform_operator into v_is_operator$n$);

-- Every live org gets the role's rows at baseline. `on conflict do nothing`,
-- so no deviation an operator has recorded is touched.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

-- ── 6. Policies ────────────────────────────────────────────────────────────
-- Each is re-stated from its live expression with one clause added around it,
-- never retyped.
do $$
declare
  r record;
  q text;
begin
  for r in select * from (values
      -- refused outright: money, tenancy terms, applicant PII, asset costs
      ('rent_charges',                  'rent_charges_select',                  'refuse', null),
      ('sc_budgets',                    'sc_budgets_select',                    'refuse', null),
      ('service_charges',               'service_charges_select',               'refuse', null),
      ('leases',                        'leases_select',                        'refuse', null),
      ('lease_notices',                 'lease_notices_select',                 'refuse', null),
      ('tenant_applications',           'tenant_applications_staff_select',     'refuse', null),
      ('application_document_findings', 'application_document_findings_select', 'refuse', null),
      ('assets',                        'assets_select',                        'refuse', null),
      -- behind a switch
      ('properties',                    'properties_select',                    'gate',   'owner_rep.properties'),
      ('units',                         'units_select',                         'gate',   'owner_rep.properties')
    ) v(tbl, pol, mode, cap)
  loop
    select pg_get_expr(p.polqual, p.polrelid) into q
      from pg_policy p where p.polrelid = r.tbl::regclass and p.polname = r.pol;
    if q is null then
      raise exception '0327: policy %.% not found', r.tbl, r.pol;
    end if;
    if q like '%caller_is_owner_rep%' then
      raise exception '0327: policy %.% already states the Owner Rep', r.tbl, r.pol;
    end if;
    if r.mode = 'refuse' then
      execute format('alter policy %I on %I using ((%s) and (select not caller_is_owner_rep()))',
                     r.pol, r.tbl, q);
    else
      execute format(
        'alter policy %I on %I using ((%s) and ((select not caller_is_owner_rep()) or (select has_permission(%L))))',
        r.pol, r.tbl, q, r.cap);
    end if;
  end loop;

  -- Requests: one branch added — every request on a property they represent.
  select pg_get_expr(p.polqual, p.polrelid) into q
    from pg_policy p where p.polrelid = 'tickets'::regclass and p.polname = 'tickets_select';
  if q is null or q like '%caller_is_owner_rep%' then
    raise exception '0327: tickets_select missing or already changed';
  end if;
  execute format($f$alter policy tickets_select on tickets using ((%s) or (
      (org_id = current_user_org_id())
      and (select caller_is_owner_rep())
      and (select has_permission('owner_rep.requests_read'))
      and (property_id in (select current_user_property_ids()))))$f$, q);

  -- Raising: only on a property they represent, and only while switched on.
  select pg_get_expr(p.polwithcheck, p.polrelid) into q
    from pg_policy p where p.polrelid = 'tickets'::regclass and p.polname = 'tickets_insert';
  if q is null or q like '%caller_is_owner_rep%' then
    raise exception '0327: tickets_insert missing or already changed';
  end if;
  execute format($f$alter policy tickets_insert on tickets with check ((%s) and (
      (select not caller_is_owner_rep())
      or ((select has_permission('owner_rep.requests_raise'))
          and (property_id in (select current_user_property_ids())))))$f$, q);
end $$;

-- ── 7. The applications view ───────────────────────────────────────────────
-- `application_overview` is NOT security_invoker: it runs as its owner and its
-- own WHERE is the gate, so the policy above does not reach it.
do $$
declare
  d text;
  o text := 'OR (property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids))));';
  n text := 'OR (property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids))) AND (NOT caller_is_owner_rep()));';
begin
  d := replace(pg_get_viewdef('public.application_overview'::regclass), E'\r', '');
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0327: application_overview — expected its WHERE clause exactly once';
  end if;
  execute 'create or replace view public.application_overview as ' || replace(d, o, n);
end $$;

-- ── 8. Functions that read the place resolver ─────────────────────────────
select pg_temp.swap_fn('public.property_statement(uuid, date, date, text)'::regprocedure,
$o$         p.id in (select current_user_property_ids())
         or current_user_role() = any (oversight_roles())$o$,
$n$         (p.id in (select current_user_property_ids()) and not caller_is_owner_rep())
         or current_user_role() = any (oversight_roles())$n$);

select pg_temp.swap_fn('public.property_statement_lines(uuid, date, date, text)'::regprocedure,
$o$         p.id in (select current_user_property_ids())
         or current_user_role() = any (oversight_roles())$o$,
$n$         (p.id in (select current_user_property_ids()) and not caller_is_owner_rep())
         or current_user_role() = any (oversight_roles())$n$);

select pg_temp.swap_fn('public.create_rent_payment_intent(uuid, payment_gateway)'::regprocedure,
$o$     and not (l.property_id in (select current_user_property_ids())) then$o$,
$n$     and not (l.property_id in (select current_user_property_ids()) and not caller_is_owner_rep()) then$n$);

select pg_temp.swap_fn('public.create_service_charge_payment_intent(uuid, payment_gateway)'::regprocedure,
$o$     and not (v_property_id is not null and v_property_id in (select current_user_property_ids())) then$o$,
$n$     and not (v_property_id is not null and v_property_id in (select current_user_property_ids())
              and not caller_is_owner_rep()) then$n$);

select pg_temp.swap_fn('public.archived_assets()'::regprocedure,
$o$      or property_id in (select current_user_property_ids())$o$,
$n$      or (property_id in (select current_user_property_ids()) and not caller_is_owner_rep())$n$);

select pg_temp.swap_fn('public.find_asset_by_identifier(text)'::regprocedure,
$o$      or a.property_id in (select current_user_property_ids())$o$,
$n$      or (a.property_id in (select current_user_property_ids()) and not caller_is_owner_rep())$n$);

select pg_temp.swap_fn('public.contest_document_finding(uuid, text)'::regprocedure,
$o$         or a.property_id in (select current_user_property_ids())
       )
  ) then$o$,
$n$         or (a.property_id in (select current_user_property_ids()) and not caller_is_owner_rep())
       )
  ) then$n$);

-- ── 9. The asset register an Owner Rep reads ──────────────────────────────
-- The table carries purchase, replacement and insured values, and column
-- privileges are per database role (every signed-in person is
-- `authenticated`), so the row cannot be narrowed by column in a policy. They
-- read this instead: the operational columns, on properties they represent,
-- while the switch is on. Notes and custom fields are left out because they
-- are free text that can carry a figure.
create or replace function owner_rep_asset_register(p_asset_id uuid default null)
returns table (
  id uuid, property_id uuid, property_name text, unit_id uuid, unit_label text,
  asset_tag text, name text, category text, description text, manufacturer text,
  model text, serial_number text, location_detail text, scope text, mobility text,
  quantity integer, status text, condition text, criticality text,
  purchase_date date, commissioned_date date, warranty_expiry date,
  expected_life_years integer, last_serviced_at date, next_service_due date,
  maintenance_strategy text, service_interval_days integer,
  service_interval_hours numeric, running_hours numeric,
  compliance_required boolean, regulatory_standard text, certifying_body text,
  certificate_number text, certificate_expiry date, last_inspection_date date,
  next_inspection_due date, created_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select a.id, a.property_id, p.name, a.unit_id, u.label,
         a.asset_tag, a.name, a.category::text, a.description, a.manufacturer,
         a.model, a.serial_number, a.location_detail, a.scope, a.mobility,
         a.quantity, a.status::text, a.condition::text, a.criticality::text,
         a.purchase_date, a.commissioned_date, a.warranty_expiry,
         a.expected_life_years, a.last_serviced_at, a.next_service_due,
         a.maintenance_strategy, a.service_interval_days,
         a.service_interval_hours, a.running_hours,
         a.compliance_required, a.regulatory_standard, a.certifying_body,
         a.certificate_number, a.certificate_expiry, a.last_inspection_date,
         a.next_inspection_due, a.created_at
    from assets a
    join properties p on p.id = a.property_id
    left join units u on u.id = a.unit_id
   where caller_is_owner_rep()
     and has_permission('owner_rep.assets')
     and a.org_id = current_user_org_id()
     and a.deleted_at is null
     and p.deleted_at is null
     and a.property_id in (select current_user_property_ids())
     and (p_asset_id is null or a.id = p_asset_id)
   order by p.name, a.asset_tag;
$$;

revoke all on function owner_rep_asset_register(uuid) from public, anon, authenticated, service_role;
grant execute on function owner_rep_asset_register(uuid) to authenticated;

comment on function owner_rep_asset_register(uuid) is
  'The asset register as an Owner Rep may read it: operational columns only, no purchase, replacement or insured value, on properties they represent, behind owner_rep.assets. 0327.';

-- ── 10. Who may be attached as a representative ────────────────────────────
create or replace function owner_rep_invitation_shape()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'owner_representative' then
    -- Set, not trusted: the relation follows the role.
    new.property_relation := 'representative';
    if coalesce(cardinality(new.property_ids), 0) = 0 then
      raise exception 'An Owner Rep is invited to the properties they represent — choose at least one.';
    end if;
    if new.node_id is not null or new.unit_id is not null or new.vendor_id is not null then
      raise exception 'An Owner Rep is attached to properties only — not to a region, a unit or a vendor company.';
    end if;
  elsif new.property_relation = 'representative' then
    raise exception 'Only an Owner Rep is attached to a property as its representative.';
  end if;
  return new;
end $$;

drop trigger if exists invitations_owner_rep_shape on invitations;
create trigger invitations_owner_rep_shape
  before insert or update of role, property_relation, property_ids, node_id, unit_id, vendor_id
  on invitations for each row execute function owner_rep_invitation_shape();

create or replace function owner_rep_stakeholder_shape()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
begin
  select u.role into v_role from users u where u.id = new.user_id;
  if v_role = 'owner_representative'
     and (new.relation <> 'representative' or new.node_id is not null) then
    raise exception 'An Owner Rep is attached to a property as its representative, and to nothing else.';
  end if;
  if new.relation = 'representative' and v_role is distinct from 'owner_representative' then
    raise exception 'Only an Owner Rep is attached to a property as its representative.';
  end if;
  return new;
end $$;

revoke all on function owner_rep_stakeholder_shape() from public, anon, authenticated, service_role;

drop trigger if exists property_stakeholders_owner_rep_shape on property_stakeholders;
create trigger property_stakeholders_owner_rep_shape
  before insert or update of relation, user_id, node_id
  on property_stakeholders for each row execute function owner_rep_stakeholder_shape();

-- A role change into or out of the Owner Rep while attachments disagree with
-- it. Nothing in the product changes a role today; this keeps a direct write
-- from producing a representative who is a manager, or the reverse.
create or replace function owner_rep_role_change_shape()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if new.role = 'owner_representative' and exists (
         select 1 from property_stakeholders s
          where s.user_id = new.id and (s.relation <> 'representative' or s.node_id is not null)) then
      raise exception 'Detach this person from their properties before making them an Owner Rep.';
    end if;
    if old.role = 'owner_representative' and exists (
         select 1 from property_stakeholders s
          where s.user_id = new.id and s.relation = 'representative') then
      raise exception 'Detach this Owner Rep from the properties they represent before changing their role.';
    end if;
  end if;
  return new;
end $$;

revoke all on function owner_rep_role_change_shape() from public, anon, authenticated, service_role;
revoke all on function owner_rep_invitation_shape() from public, anon, authenticated, service_role;

drop trigger if exists users_owner_rep_role_change on users;
create trigger users_owner_rep_role_change
  before update of role on users
  for each row execute function owner_rep_role_change_shape();

-- ── 11. Assertions ─────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  -- The baseline: exactly the five switches, and nothing else, for the role.
  select count(*) into n from capabilities c
   where b7_grants('owner_representative', c.key) and not c.locked;
  if n <> 5 then
    raise exception '0327: an Owner Rep should hold exactly its 5 switches at baseline, holds %', n;
  end if;
  if exists (select 1 from capabilities c
              where c.key like 'owner\_rep.%'
                and exists (select 1 from unnest(enum_range(null::user_role)) r
                             where r <> 'owner_representative' and b7_grants(r, c.key))) then
    raise exception '0327: an Owner Rep switch is granted to another role at baseline';
  end if;
  if exists (select 1 from role_permissions
              where role = 'owner_representative' and granted and capability not like 'owner\_rep.%') then
    raise exception '0327: an Owner Rep holds a capability that is not its own';
  end if;

  -- Every money table refuses the role in its own words.
  if exists (
    select 1 from (values ('rent_charges','rent_charges_select'), ('sc_budgets','sc_budgets_select'),
                          ('service_charges','service_charges_select'), ('leases','leases_select'),
                          ('lease_notices','lease_notices_select'), ('assets','assets_select'),
                          ('tenant_applications','tenant_applications_staff_select'),
                          ('application_document_findings','application_document_findings_select')) v(t, p)
     where not exists (select 1 from pg_policy x
                        where x.polrelid = v.t::regclass and x.polname = v.p
                          and pg_get_expr(x.polqual, x.polrelid) like '%NOT caller_is_owner_rep()%')
  ) then
    raise exception '0327: a money or PII policy does not refuse the Owner Rep';
  end if;

  -- The definer helpers are not callable from outside.
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('owner_rep_stakeholder_shape', 'owner_rep_role_change_shape',
                                     'owner_rep_invitation_shape')
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0327: a trigger function is executable by a client role';
  end if;
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('owner_rep_asset_register', 'caller_is_owner_rep')
                and grantee in ('PUBLIC', 'anon')) then
    raise exception '0327: an Owner Rep function is callable anonymously';
  end if;
end $$;
