-- A unit row is one unit, vacancy is one rule, and it counts in both directions.
--
-- The board asked a plain question: record how many units a property has when
-- it is enrolled, then watch that number fall as units are let and rise as they
-- are given up, with `auto` intake following it. Three things stood in the way,
-- and only the third was a missing feature.
--
-- == 1. `unit_quantity` recorded the number where nothing could count it =====
-- 0198 let one row stand for twelve stalls, and deliberately left
-- `property_windows.vacant_count` counting ROWS, reasoning that "a row of 12
-- vacant stalls answers [the auto question] identically whether counted as 1 or
-- 12". That is true of the BOOLEAN and false of everything else. One occupant
-- on that row reads as 0 vacant, closes the window, and -- because
-- `leases_no_overlap` excludes on (unit_id, daterange) -- permits exactly one
-- concurrent tenancy, so the other eleven stalls can never be let at all.
--
-- Occupancy is a single `occupant_user_id`, a lease points at a single
-- `unit_id`, a service-charge invoice is raised per unit, and 0009 lets a
-- tenant see their own unit by that same column. Every consumer needs an
-- IDENTIFIABLE unit per tenancy. So quantity stops being a number carried on
-- one row and becomes what it always meant on the way in: **create that many
-- rows**.
--
-- !! The COLUMN stays, constrained to 1. `property_summary.total_factor`,
-- `unit_total` and `lib/apportionment.ts:effectiveFactor` all multiply by it,
-- and with every row at 1 that arithmetic is unchanged and still literally
-- correct. Dropping it would mean rewriting four consumers to prove the same
-- number. 0198's warning about quietly changing what a published column means
-- applies here too, and the cheapest way to honour it is to leave the column
-- saying what it says.
--
-- == 2. "Vacant" had two definitions that were free to disagree =============
-- The counters and the auto window asked `occupant_user_id is null`. The lease
-- picker asked "is there an active or renewed lease?". Occupancy is ALSO set by
-- invitation acceptance (0020/0026/0081/0153/0163), which creates no lease, and
-- `activate_lease` skips the occupant write entirely when `tenant_user_id` is
-- null -- a company let with no portal user. So a unit could read full to the
-- window and vacant to the picker at the same time, in both directions. One
-- rule now, `unit_is_vacant`, and all three read it.
--
-- == 3. It only ever counted down ==========================================
-- `activate_lease` sets the occupant; nothing anywhere cleared it. No function
-- in this schema set a lease to `expired` or `terminated` -- the enum has held
-- both values since 0090 and had no writer. `createLease`'s own error copy
-- tells a letting agent to "End or terminate the existing tenancy first",
-- naming an act that did not exist. `end_tenancy` is that act.
--
-- !! **Expiry does not vacate a unit.** `expire_due_leases` flips a lease past
-- its end date to `expired` and touches occupancy not at all, because a tenant
-- holding over past expiry is ordinary here and auto-vacating would advertise
-- an occupied flat as available. The lease's state is date arithmetic; the
-- unit's state is a fact about a person, and someone records it. That is the
-- same line 0076 drew when it refused to derive the intake window with no
-- override: automation informs the decision, it does not remove it.

-- == The naming helper =====================================================
-- 0198 made `label` a chosen TYPE ("Stall", "Terrace") and `description` the
-- distinguisher, keyed together by units_property_label_desc_uidx. Twelve
-- stalls are therefore twelve rows sharing a label and differing in
-- description, which is fine until something prints `u.label` alone -- as
-- `rent_roll` and `leases_due_for_notice` both do, and as the lease picker did.
-- A dropdown of twelve identical "Stall" entries is not a choice.
create or replace function unit_display_label(p_label text, p_description text)
returns text language sql immutable set search_path = public as $$
  select case
           when nullif(trim(coalesce(p_description, '')), '') is null then p_label
           else p_label || ' - ' || trim(p_description)
         end;
$$;

comment on function unit_display_label is
  'How a unit is named to a person: the type, then its distinguisher. Since 0198 the label alone is a TYPE, so twelve stalls print twelve identical labels without this.';

-- Numbering that cannot collide with what is already filed.
--
-- Starts at the number asked for and walks up until the (property, label,
-- description) key is free, so expanding a 3-stall row into a property that
-- already holds "Stall - 1" produces 2, 3, 4 rather than failing on the unique
-- index. Live rows only: a retired unit does not reserve its name, which is the
-- same rule the partial index itself applies.
create or replace function next_free_unit_description(
  p_property_id uuid,
  p_label       text,
  p_base        text,
  p_from        integer
)
returns text language plpgsql stable set search_path = public as $$
declare
  v_base text := nullif(trim(coalesce(p_base, '')), '');
  v_n    integer := greatest(coalesce(p_from, 1), 1);
  v_try  text;
begin
  loop
    v_try := case when v_base is null then v_n::text else v_base || ' ' || v_n::text end;
    exit when not exists (
      select 1 from units u
       where u.property_id = p_property_id
         and lower(u.label) = lower(p_label)
         and lower(coalesce(u.description, '')) = lower(v_try)
         and u.deleted_at is null
    );
    v_n := v_n + 1;
    if v_n > 100000 then
      raise exception 'could not find a free description for % on that property', p_label;
    end if;
  end loop;
  return v_try;
end;
$$;

-- == 1. Expand every multi-unit row into real units ========================
--
-- The original row KEEPS its identity -- its id, its occupant, and any lease
-- pointing at it -- and becomes unit 1. The rest are new and vacant, which is
-- the truthful reading: a row of 12 stalls with one occupant was one let stall
-- and eleven empty ones the whole time. It is only now that the register can
-- say so.
do $$
declare
  r        record;
  v_base   text;
  i        integer;
  v_rows   integer := 0;
  v_units  integer := 0;
begin
  for r in
    select * from units where deleted_at is null and unit_quantity > 1
     order by property_id, label
  loop
    v_base := nullif(trim(coalesce(r.description, '')), '');

    update units
       set description   = next_free_unit_description(r.property_id, r.label, v_base, 1),
           unit_quantity = 1
     where id = r.id;

    for i in 2..r.unit_quantity loop
      insert into units (org_id, property_id, label, apportionment_factor, unit_quantity, description)
      values (
        r.org_id, r.property_id, r.label, r.apportionment_factor, 1,
        next_free_unit_description(r.property_id, r.label, v_base, i)
      );
      v_units := v_units + 1;
    end loop;

    v_rows := v_rows + 1;
    v_units := v_units + 1;

    -- Audited, because a unit appearing in a register nobody asked to change is
    -- exactly the kind of thing an auditor should be able to trace to a reason.
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
    values (
      r.org_id, null, 'unit.expanded_from_quantity', 'unit', r.id,
      jsonb_build_object('label', r.label, 'unit_quantity', r.unit_quantity,
                         'description', r.description),
      jsonb_build_object('rows_created', r.unit_quantity, 'migration', '0200')
    );
  end loop;

  if v_rows > 0 then
    raise notice '0200: expanded % multi-unit row(s) into % unit(s)', v_rows, v_units;
  end if;
end;
$$;

-- Going forward the rule is in the database, not only in the server action. A
-- direct insert of `unit_quantity => 5` is the same defect arriving by a
-- different door, and units_insert admits anyone holding `properties.write`.
alter table units drop constraint if exists units_quantity_is_one;
alter table units add constraint units_quantity_is_one check (unit_quantity = 1);

comment on column units.unit_quantity is
  'Always 1 since 0200 - a row is one unit. Retained rather than dropped because total_factor, unit_total and effectiveFactor all multiply by it and the arithmetic stays correct at 1. On the way IN, "how many" now creates that many rows (create_units): occupancy, a lease, an invoice and a tenant''s own visibility (0009) each need an identifiable unit, and a count on one row gives them none.';

-- == 2. One definition of vacant ===========================================
--
-- No occupant AND no live tenancy covering today. Both halves are load-bearing:
--   * the occupant alone missed a lease activated with no portal user
--   * the lease alone missed every occupancy set by invitation acceptance
--
-- SECURITY DEFINER so the answer does not change with who is asking. The
-- alternative -- reading `leases` as the caller -- would report a unit vacant
-- to anyone who cannot see the lease holding it, which is precisely the reader
-- who would then try to let it.
--
-- "Covering today" rather than "any live lease": a tenancy that ends in March
-- does not make the flat occupied in May, and `leases_no_overlap` remains the
-- backstop that refuses an actual double-let.
create or replace function unit_is_vacant(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from units u
     where u.id = p_unit_id
       and u.deleted_at is null
       and u.occupant_user_id is null
       and not exists (
         select 1 from leases l
          where l.unit_id = u.id
            and l.deleted_at is null
            and l.status in ('active', 'renewed')
            and l.start_date <= current_date
            and l.end_date   >  current_date
       )
  );
$$;

revoke all on function unit_is_vacant(uuid) from public;
grant execute on function unit_is_vacant(uuid) to authenticated, service_role;

comment on function unit_is_vacant is
  'THE definition of a vacant unit: no occupant and no live tenancy covering today. Read by the property counters, the auto intake window and the lease picker - before 0200 those three asked two different questions and were free to disagree.';

-- What the lease form offers, named so twelve stalls can be told apart.
create or replace function vacant_units_for_property(p_property_id uuid)
returns table (id uuid, label text, display_label text)
language sql stable set search_path = public as $$
  select u.id, u.label, unit_display_label(u.label, u.description)
    from units u
   where u.property_id = p_property_id
     and u.deleted_at is null
     and unit_is_vacant(u.id)
   order by u.label, u.description nulls first;
$$;

revoke all on function vacant_units_for_property(uuid) from public;
grant execute on function vacant_units_for_property(uuid) to authenticated, service_role;

comment on function vacant_units_for_property is
  'What the lease form offers. Deliberately NOT security definer: which property''s units you may read is the caller''s own business and `units` RLS already decides it. Only the vacancy TEST is definer.';

-- == 3. The three readers, now reading the one rule ========================

-- The auto window. Rebuilt from 0076 with the vacancy test replaced and
-- nothing else touched -- the org master switch, the module check and the two
-- overrides are unchanged.
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

  if not org_accepts_tenant_applications(p.org_id) then
    return false;
  end if;

  if p.applications_state = 'closed' then
    return false;
  end if;
  if p.applications_state = 'open' then
    return true;
  end if;

  -- 'auto': a live unit nobody is in and nobody is contracted to be in.
  select count(*) into v_vacant
    from units u
   where u.property_id = p.id
     and u.deleted_at is null
     and unit_is_vacant(u.id);

  return v_vacant > 0;
end;
$$;

-- Rebuilt from 0077's definition -- `security_invoker` and the org filter are
-- kept exactly. Only `vacant_count` changes, and it now agrees with the lease
-- picker by construction. The units it counts are still the ones the CALLER may
-- read; only the vacancy test is definer, so a reader cannot be told a unit is
-- free because they happen not to see the tenancy in it.
create or replace view property_application_windows
with (security_invoker = on) as
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
        and unit_is_vacant(u.id))                             as vacant_count
  from properties p
 where p.org_id = current_user_org_id()
   and p.deleted_at is null;

comment on view property_application_windows is
  'Per-property intake state and the vacancy behind it. `security_invoker`, so the caller''s own `properties` policies decide what they see (audit 0729b-S2). vacant_count reads `unit_is_vacant` since 0200 - the one definition the auto window and the lease picker also read.';

revoke all on property_application_windows from anon;
grant select on property_application_windows to authenticated;

-- Rebuilt from 0198's definition. `occupied_count` is the only line that
-- changes, and it changes to the complement of the same rule -- so
-- occupied + vacant = unit_count for every property, which is asserted below
-- rather than assumed.
--
-- !! This is a real change of meaning, and a deliberate one. It was "rows with
-- an occupant"; it is now "rows that are not vacant", which additionally counts
-- a unit held by a live lease that never wrote an occupant. That unit was
-- always occupied; the register simply could not say so, and offered it to be
-- let a second time.
drop view if exists property_summary;
create view property_summary as
  select
    p.id,
    p.org_id,
    p.name,
    p.reference,
    p.address,
    p.property_type,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null)              as unit_count,
    (select coalesce(sum(u.unit_quantity), 0) from units u
      where u.property_id = p.id and u.deleted_at is null)              as unit_total,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null
        and not unit_is_vacant(u.id))                                   as occupied_count,
    (select coalesce(sum(u.apportionment_factor * u.unit_quantity), 0) from units u
      where u.property_id = p.id and u.deleted_at is null)              as total_factor,
    (select count(*) from assets a
      where a.property_id = p.id and a.deleted_at is null)              as asset_count,
    p.site_node_id,
    case when p.site_node_id is not null then node_full_name(p.site_node_id) end as node_path
  from properties p
 where p.deleted_at is null;

comment on view property_summary is
  'Per-property rollup. unit_count is how many unit ROWS exist; unit_total is how many physical units they stand for (always equal since 0200 made a row one unit); total_factor is occupied space x quantity, which is what the service-charge apportionment divides by. occupied_count is the complement of `unit_is_vacant` (0200).';

-- == 4. Recording how many units a property has, at enrolment =============
--
-- The single write path for creating units. Takes a jsonb array so the "add a
-- unit" form, the enrolment form and the CSV import are one path rather than
-- three -- 0063's "one way in" rule, applied to the register.
--
-- NOT security definer: `units_insert` (0059) already says who may bring a unit
-- into existence, and this must not become a way around it. It reads `org_id`
-- off the property through the caller's own policies for the same reason.
--
-- Each element: {label, factor, quantity, description, occupant_user_id}.
-- `quantity` > 1 creates that many numbered rows. An occupant, if given, lands
-- on the FIRST of them only -- the others are genuinely empty, and inventing an
-- occupancy for them is the defect this migration exists to end.
create or replace function create_units(p_property_id uuid, p_rows jsonb)
returns integer language plpgsql set search_path = public as $$
declare
  v_org        uuid;
  e            jsonb;
  v_label      text;
  v_factor     numeric;
  v_qty        integer;
  v_base       text;
  v_occupant   uuid;
  v_desc       text;
  i            integer;
  v_created    integer := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'units must be given as an array';
  end if;

  select org_id into v_org from properties
   where id = p_property_id and deleted_at is null;
  if v_org is null then
    raise exception 'that property does not exist, or you cannot reach it';
  end if;

  for e in select * from jsonb_array_elements(p_rows) loop
    v_label  := nullif(trim(coalesce(e ->> 'label', '')), '');
    v_factor := (e ->> 'factor')::numeric;
    v_qty    := coalesce((e ->> 'quantity')::integer, 1);
    v_base   := nullif(trim(coalesce(e ->> 'description', '')), '');
    v_occupant := nullif(e ->> 'occupant_user_id', '')::uuid;

    if v_label is null then
      raise exception 'every unit needs a type';
    end if;
    if v_factor is null or v_factor <= 0 then
      raise exception 'the occupied space for % must be greater than zero', v_label;
    end if;
    if v_qty < 1 then
      raise exception 'the number of % units must be at least 1', v_label;
    end if;

    for i in 1..v_qty loop
      -- A single unit keeps the description exactly as it was typed. Numbering
      -- only appears where there is something to tell apart, so an ordinary
      -- flat does not acquire a " 1" it never asked for.
      v_desc := case
                  when v_qty = 1 then v_base
                  else next_free_unit_description(p_property_id, v_label, v_base, i)
                end;

      insert into units (org_id, property_id, label, apportionment_factor,
                         unit_quantity, description, occupant_user_id)
      values (v_org, p_property_id, v_label, v_factor, 1, v_desc,
              case when i = 1 then v_occupant else null end);

      v_created := v_created + 1;
    end loop;
  end loop;

  return v_created;
end;
$$;

revoke all on function create_units(uuid, jsonb) from public;
grant execute on function create_units(uuid, jsonb) to authenticated, service_role;

comment on function create_units is
  'The one write path for creating units. "How many" creates that many numbered rows rather than a count on one row (0200). Invoker rights: units_insert (0059) decides who may do this, and this function must not become a way past it.';

-- == 5. Counting back up ===================================================
--
-- The act `createLease`'s error message has been naming since 0090 without it
-- existing. Ends a live tenancy and hands the unit back.
--
-- The status told from the date: a tenancy ending on or after its end date has
-- `expired`, one ended before it was `terminated`. Two words that mean
-- different things to a landlord, and guessing wrong makes a renewal history
-- read as a string of evictions.
create or replace function end_tenancy(p_lease_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  l        leases%rowtype;
  v_caller uuid := auth.uid();
  v_status lease_status;
  v_freed  boolean := false;
begin
  select * into l from leases where id = p_lease_id and deleted_at is null;
  if l.id is null then
    raise exception 'that tenancy could not be found';
  end if;

  if v_caller is not null then
    if l.org_id is distinct from current_user_org_id() then
      raise exception 'that tenancy belongs to another organisation';
    end if;
    if not has_permission('leases.write') then
      raise exception 'you do not have permission to end a tenancy';
    end if;
  end if;

  if l.status not in ('active', 'renewed') then
    raise exception 'only a live tenancy can be ended - this one is %', l.status;
  end if;

  v_status := case when current_date >= l.end_date then 'expired' else 'terminated' end;

  update leases set status = v_status where id = p_lease_id;

  -- !! Cleared only if the unit still holds THIS tenancy's tenant. If someone
  -- else has since been recorded there, blanking it would erase a real
  -- occupancy on the strength of an old lease -- and a unit wrongly shown
  -- vacant is one that gets advertised and let a second time.
  if l.tenant_user_id is not null then
    update units
       set occupant_user_id = null
     where id = l.unit_id
       and org_id = l.org_id
       and occupant_user_id = l.tenant_user_id;
    v_freed := found;
  end if;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    l.org_id, v_caller, 'lease.ended', 'lease', l.id,
    jsonb_build_object('status', l.status, 'unit_id', l.unit_id,
                       'tenant_user_id', l.tenant_user_id),
    jsonb_build_object('status', v_status, 'reason', nullif(trim(coalesce(p_reason, '')), ''),
                       'unit_freed', v_freed)
  );
end;
$$;

revoke all on function end_tenancy(uuid, text) from public;
grant execute on function end_tenancy(uuid, text) to authenticated, service_role;

comment on function end_tenancy is
  'Ends a live tenancy and hands the unit back, which is what makes the vacancy count rise. Status is told from the date - expired at or after the end date, terminated before it. The occupant is cleared only if the unit still holds this lease''s tenant.';

-- The daily sweep. Flips a live tenancy past its end date to `expired`.
--
-- !! It does NOT free the unit, and that is the whole design. A tenant holding
-- over past expiry is ordinary in this market; marking the flat vacant on the
-- strength of a date would advertise an occupied home. The lease going
-- `expired` is what puts it in front of a person, and `end_tenancy` is what
-- that person calls when the keys actually come back.
create or replace function expire_due_leases(p_org_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_count  integer;
begin
  if v_caller is not null then
    if p_org_id is distinct from current_user_org_id() then
      raise exception 'that organisation is not yours';
    end if;
    if current_user_role() not in ('admin', 'executive') then
      raise exception 'only an administrator may run the expiry sweep by hand';
    end if;
  end if;

  with due as (
    update leases
       set status = 'expired'
     where org_id = p_org_id
       and deleted_at is null
       and status in ('active', 'renewed')
       and end_date <= current_date
    returning id, org_id, unit_id, tenant_user_id
  )
  select count(*) into v_count from due;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function expire_due_leases(uuid) from public;
grant execute on function expire_due_leases(uuid) to authenticated, service_role;

comment on function expire_due_leases is
  'Flips live tenancies past their end date to `expired`. Deliberately does not touch occupancy: a tenant holding over is ordinary, and a date is not evidence they have gone. Freeing the unit is `end_tenancy`, which a person calls.';

-- == 6. Two views that printed a bare type ================================
--
-- Rebuilt from 0091 with `unit_label` carrying the distinguisher. Since 0198
-- the label alone is a type, so a rent roll of twelve stalls printed twelve
-- identical rows and a renewal notice told a tenant their "Stall" was expiring.
create or replace view rent_roll
with (security_invoker = on) as
  select
    l.id                as lease_id,
    l.org_id,
    l.property_id,
    p.name              as property_name,
    l.unit_id,
    unit_display_label(u.label, u.description) as unit_label,
    l.tenant_user_id,
    t.full_name         as tenant_name,
    t.email             as tenant_email,
    l.status,
    l.start_date,
    l.end_date,
    (l.end_date - current_date)              as days_to_expiry,
    l.rent_amount,
    l.rent_frequency,
    l.escalation_pct,
    l.currency,
    coalesce(c.billed, 0)                    as rent_billed,
    coalesce(c.collected, 0)                 as rent_collected,
    coalesce(c.billed, 0) - coalesce(c.collected, 0) as rent_outstanding,
    coalesce(c.mgmt_fees, 0)                 as management_fees,
    coalesce(c.admin_fees, 0)                as admin_fees,
    coalesce(c.landlord_net, 0)              as landlord_net
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  left join lateral (
    select
      sum(rc.amount)                as billed,
      sum(rc.amount_paid)           as collected,
      sum(rc.management_fee_amount) as mgmt_fees,
      sum(rc.admin_fee_amount)      as admin_fees,
      sum(rc.landlord_net_amount)   as landlord_net
    from rent_charges rc
    where rc.lease_id = l.id
  ) c on true
  where l.deleted_at is null;

comment on view rent_roll is
  'The tenancy schedule: who is in which unit, until when, for how much, and what has been collected. security_invoker - a landlord sees their portfolio and an FM/PM their properties, with no scoping rule written twice. unit_label carries the distinguisher since 0200.';

grant select on rent_roll to authenticated;

create or replace function leases_due_for_notice(p_org_id uuid)
returns table (
  lease_id uuid,
  tenant_user_id uuid,
  tenant_name text,
  tenant_email text,
  property_name text,
  unit_label text,
  end_date date,
  days_remaining integer,
  rent_amount numeric,
  proposed_rent numeric
)
language sql stable security definer set search_path = public as $$
  select
    l.id, l.tenant_user_id, t.full_name, t.email,
    p.name, unit_display_label(u.label, u.description), l.end_date,
    (l.end_date - current_date)::integer,
    l.rent_amount,
    round(l.rent_amount * (1 + l.escalation_pct / 100.0), 2)
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  join orgs o       on o.id = l.org_id
  where l.org_id = p_org_id
    and l.deleted_at is null
    and l.status = 'active'
    and (l.end_date - current_date)::integer = any (o.renewal_notice_days);
$$;

revoke all on function leases_due_for_notice(uuid) from public;
grant execute on function leases_due_for_notice(uuid) to authenticated, service_role;

comment on function leases_due_for_notice is
  'Leases whose remaining days EQUAL a configured lead time, so a daily run notifies once per threshold. A <= test would re-send every day until expiry.';

-- == 7. Prove it, rather than reporting success ============================
do $$
declare
  v_bad     integer;
  v_unit    uuid;
  v_prop    uuid;
begin
  -- Every row is one unit now.
  select count(*) into v_bad from units where unit_quantity <> 1 and deleted_at is null;
  if v_bad > 0 then
    raise exception '% unit row(s) still stand for more than one unit', v_bad;
  end if;

  -- unit_total and unit_count must now agree for every property, because a row
  -- is a unit. If they ever diverge again, something has written a quantity.
  select count(*) into v_bad from property_summary where unit_count <> unit_total;
  if v_bad > 0 then
    raise exception '% property/properties disagree on unit_count vs unit_total', v_bad;
  end if;

  -- The complement holds: occupied + vacant = every live unit, per property.
  select count(*) into v_bad
    from property_summary s
   where s.occupied_count + (
           select count(*) from units u
            where u.property_id = s.id and u.deleted_at is null and unit_is_vacant(u.id)
         ) <> s.unit_count;
  if v_bad > 0 then
    raise exception 'occupied + vacant does not equal unit_count on % property/properties', v_bad;
  end if;

  -- A unit with an occupant is never vacant.
  select count(*) into v_bad
    from units u
   where u.deleted_at is null
     and u.occupant_user_id is not null
     and unit_is_vacant(u.id);
  if v_bad > 0 then
    raise exception '% occupied unit(s) report themselves vacant', v_bad;
  end if;

  -- A unit under a live tenancy covering today is never vacant, even where no
  -- occupant was ever written. This is the case the old definition missed.
  select count(*) into v_bad
    from leases l
   where l.deleted_at is null
     and l.status in ('active', 'renewed')
     and l.start_date <= current_date
     and l.end_date   >  current_date
     and unit_is_vacant(l.unit_id);
  if v_bad > 0 then
    raise exception '% unit(s) under a live tenancy report themselves vacant', v_bad;
  end if;

  -- The numbering helper actually avoids a collision rather than returning the
  -- first thing it thought of.
  --
  -- Tested against real rows rather than a probe row: units carries an audit
  -- trigger and a hard-delete block, so inserting a throwaway unit to assert
  -- with would leave both a unit and an audit entry behind if anything after it
  -- raised. A live unit whose description already ENDS in a number is a
  -- ready-made collision -- ask the helper for exactly that name and it must
  -- hand back a different one.
  select u.property_id, u.id into v_prop, v_unit
    from units u
   where u.deleted_at is null
     and u.description ~ '[0-9]+$'
   limit 1;

  if v_prop is not null then
    declare
      v_desc text;
      v_base text;
      v_n    integer;
    begin
      select description into v_desc from units where id = v_unit;
      v_n    := (regexp_match(v_desc, '([0-9]+)$'))[1]::integer;
      v_base := nullif(trim(regexp_replace(v_desc, '[0-9]+$', '')), '');

      if next_free_unit_description(
           v_prop, (select label from units where id = v_unit), v_base, v_n
         ) = v_desc then
        raise exception
          'next_free_unit_description handed back "%", which is already taken', v_desc;
      end if;
    end;
  end if;
end;
$$;
