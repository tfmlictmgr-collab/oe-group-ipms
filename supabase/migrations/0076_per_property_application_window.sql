-- Applications open per property, driven by vacancy but not dictated by it.
--
-- Board, 29 July 2026. Until now `orgs.tenant_applications_open` was a single
-- switch: all of OEA's properties taking applications, or none of them.
--
-- The board asked for it to follow occupancy. Deriving it with **no override**
-- would be the wrong answer even though it is what was asked: a landlord
-- legitimately wants a waiting list on a full building, and legitimately wants a
-- property closed while its units sit empty — refurbishment, a legal dispute, a
-- handover. So three states, not a computed boolean:
--
--   auto   (default) open IFF the property has a vacant, live unit
--   open             forced open — a waiting list on a full property
--   closed           forced closed — not taking applicants, whatever the units say
--
-- The org flag stays as a master switch, AND-ed with the property, so a brand can
-- stop all intake at once.
--
-- ── And it closes the Day 8 blocker ────────────────────────────────────────
--
-- Applications carried `property_id = null`, and both the RLS policy and
-- `application_overview` scope a reviewer without `applications.review_all` to
-- `property_id in (select current_user_property_ids())` — which NULL never
-- satisfies. Property-scoped review, the whole premise of Day 8, returned
-- nothing.
--
-- An applicant now arrives through a PROPERTY's link, so `property_id` is a fact
-- about how they applied rather than something they typed. That distinction
-- matters: which link someone used is sound to scope access to their identity
-- documents by; a free-text "unit preference" they asserted is not.

alter table properties
  add column if not exists applications_state text not null default 'auto'
    check (applications_state in ('auto', 'open', 'closed')),
  add column if not exists applications_state_note text,
  add column if not exists applications_state_set_by uuid references users(id),
  add column if not exists applications_state_set_at timestamptz;

comment on column properties.applications_state is
  'auto = open while a unit is vacant; open = forced (waiting list); closed = forced. Derived by default, overridable by a person, and the override is recorded — automation should inform the decision, not remove it.';

-- ── Is this property taking applications right now? ────────────────────────
--
-- SECURITY DEFINER because an anonymous applicant must be able to reach the
-- answer without being able to read `properties`, `units` or `orgs`. It answers
-- one question and reveals nothing else — the same shape as
-- `org_accepts_tenant_applications`, which it deliberately still calls rather
-- than re-implementing the module and master-switch checks.
create or replace function property_accepts_applications(p_property_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  p properties%rowtype;
  v_vacant integer;
begin
  select * into p from properties where id = p_property_id and deleted_at is null;
  if p.id is null then
    return false;
  end if;

  -- The org-level master switch and the lettings module, unchanged.
  if not org_accepts_tenant_applications(p.org_id) then
    return false;
  end if;

  if p.applications_state = 'closed' then
    return false;
  end if;
  if p.applications_state = 'open' then
    return true;
  end if;

  -- 'auto': a live unit with nobody in it.
  select count(*) into v_vacant
    from units u
   where u.property_id = p.id
     and u.deleted_at is null
     and u.occupant_user_id is null;

  return v_vacant > 0;
end;
$$;

revoke all on function property_accepts_applications(uuid) from public;
grant execute on function property_accepts_applications(uuid) to anon, authenticated, service_role;

-- What a stranger may see: the properties currently accepting, and nothing else
-- about them. This is the org's public face, so it carries a name and an address
-- and stops there — no unit counts, no occupancy, no internal reference.
create or replace function properties_accepting_applications(p_org_id uuid)
returns table (id uuid, name text, address text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.address
    from properties p
   where p.org_id = p_org_id
     and p.deleted_at is null
     and property_accepts_applications(p.id)
   order by p.name;
$$;

revoke all on function properties_accepting_applications(uuid) from public;
grant execute on function properties_accepting_applications(uuid) to anon, authenticated, service_role;

-- ── Changing the state is a decision, and is recorded as one ───────────────
create or replace function set_property_application_state(
  p_property_id uuid,
  p_state       text,
  p_note        text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  p properties%rowtype;
  v_caller uuid := auth.uid();
begin
  if p_state not in ('auto', 'open', 'closed') then
    raise exception 'unknown application state %', p_state;
  end if;

  select * into p from properties where id = p_property_id and deleted_at is null;
  if p.id is null then
    raise exception 'that property does not exist';
  end if;

  -- Definer function, so the caller's org and privilege are checked HERE. B7
  -- gives configuring intake to an administrator; a regional manager runs the
  -- properties they are assigned, not the decision to take applicants at all.
  if v_caller is not null then
    if p.org_id is distinct from current_user_org_id() then
      raise exception 'that property belongs to another organisation';
    end if;
    if current_user_role() not in ('admin', 'executive') then
      raise exception 'only an administrator may open or close applications for a property';
    end if;
  end if;

  update properties
     set applications_state = p_state,
         applications_state_note = nullif(trim(coalesce(p_note, '')), ''),
         applications_state_set_by = v_caller,
         applications_state_set_at = now()
   where id = p_property_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p.org_id, v_caller, 'property.application_state', 'property', p.id,
          jsonb_build_object('state', p.applications_state),
          jsonb_build_object('state', p_state, 'note', p_note));
end;
$$;

revoke all on function set_property_application_state(uuid, text, text) from public;
grant execute on function set_property_application_state(uuid, text, text) to authenticated, service_role;

-- What an operator sees: the state, what it currently resolves to, and why.
create or replace view property_application_windows as
  select
    p.id            as property_id,
    p.org_id,
    p.name,
    p.applications_state,
    p.applications_state_note,
    p.applications_state_set_at,
    property_accepts_applications(p.id)                       as accepting_now,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null)    as unit_count,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null
        and u.occupant_user_id is null)                       as vacant_count
  from properties p
 where p.org_id = current_user_org_id()
   and p.deleted_at is null;

comment on view property_application_windows is
  'Per-property intake state, what it resolves to right now, and the vacancy behind it — so an operator can see WHY a property is open before overriding it.';

revoke all on property_application_windows from anon;
grant select on property_application_windows to authenticated;

-- ── An application is raised against a property ────────────────────────────
--
-- The property becomes required. The old 7-argument signature is dropped rather
-- than left beside the new one: leaving it would preserve a way in that produces
-- exactly the property-less applications this migration exists to end, and "one
-- way in" is the rule 0063 established for this table.
drop function if exists start_tenant_application(uuid, application_type, text, text, text, text, timestamptz);

create or replace function start_tenant_application(
  p_org_id      uuid,
  p_property_id uuid,
  p_type        application_type,
  p_name        text,
  p_email       text,
  p_phone       text,
  p_token_hash  text,
  p_expires_at  timestamptz
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid;
  v_org uuid;
begin
  -- The property decides, and it must belong to the org in the link. Checking
  -- both stops a valid property id from another brand being posted at this org's
  -- endpoint.
  select org_id into v_org from properties where id = p_property_id and deleted_at is null;
  if v_org is null or v_org is distinct from p_org_id then
    raise exception 'this organisation is not accepting applications';
  end if;
  if not property_accepts_applications(p_property_id) then
    raise exception 'this organisation is not accepting applications';
  end if;

  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_email), '') = '' then
    raise exception 'a name and an email address are required';
  end if;

  insert into tenant_applications (
    org_id, property_id, type, status, applicant_name, applicant_email,
    applicant_phone, resume_token_hash, resume_expires_at
  ) values (
    p_org_id, p_property_id, p_type, 'draft', trim(p_name), lower(trim(p_email)),
    nullif(trim(coalesce(p_phone, '')), ''), p_token_hash, p_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function start_tenant_application(uuid, uuid, application_type, text, text, text, text, timestamptz) from public;
grant execute on function start_tenant_application(uuid, uuid, application_type, text, text, text, text, timestamptz)
  to anon, authenticated;

comment on function start_tenant_application is
  'Creates a draft against a PROPERTY. The property is what makes property-scoped review possible: an application with no property is invisible to every reviewer who is not org-wide, because NULL never matches an IN list.';

-- Seed the two brand orgs' existing properties to `auto` explicitly — the column
-- default already says so, and stating it makes the first read of the operator
-- screen match what the database will actually do.
update properties set applications_state = 'auto'
 where applications_state is null;
