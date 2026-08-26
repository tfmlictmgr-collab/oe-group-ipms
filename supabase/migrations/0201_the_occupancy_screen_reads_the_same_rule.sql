-- The occupancy screen reads the same rule as everything else.
--
-- 0200 made `unit_is_vacant` the one definition and pointed the property
-- counters, the `auto` intake window and the lease picker at it. One screen was
-- left asking the old question: People & Onboarding -> Unit Occupancy, which
-- counts "2 of 5 units occupied" from `occupant_user_id` alone.
--
-- That is the drift 0200 exists to end, one screen later. A unit let to a
-- company with no portal user has no occupant recorded, so this screen calls it
-- vacant while the property register, the intake window and the lease form all
-- correctly call it let.
--
-- ⚠️ It needs the answer for MANY properties at once, and the existing
-- `vacant_units_for_property` answers for one. Calling it in a loop is a query
-- per property, and the locked scope is 100+ properties from day one -- so the
-- array form exists rather than a loop in TypeScript, which would have been the
-- third place the rule was written down.
create or replace function vacant_unit_ids(p_property_ids uuid[])
returns table (unit_id uuid)
language sql stable set search_path = public as $$
  select u.id
    from units u
   where u.property_id = any (p_property_ids)
     and u.deleted_at is null
     and unit_is_vacant(u.id);
$$;

revoke all on function vacant_unit_ids(uuid[]) from public;
grant execute on function vacant_unit_ids(uuid[]) to authenticated, service_role;

comment on function vacant_unit_ids is
  'Which of these properties'' units are vacant, in one query. Invoker rights like `vacant_units_for_property` (0200): `units` RLS decides which properties you may ask about, and only the vacancy TEST is definer.';

do $$
declare
  v_ids uuid[];
  v_one integer;
  v_many integer;
begin
  -- The array form and the single form must agree, or there are two rules
  -- again. Asserted across every property that has units rather than one.
  select array_agg(distinct property_id) into v_ids
    from units where deleted_at is null;

  if v_ids is not null then
    select count(*) into v_many from vacant_unit_ids(v_ids);

    select count(*) into v_one
      from units u
     where u.deleted_at is null
       and unit_is_vacant(u.id);

    if v_one is distinct from v_many then
      raise exception
        'vacant_unit_ids counted % where unit_is_vacant counts %', v_many, v_one;
    end if;
  end if;
end;
$$;
