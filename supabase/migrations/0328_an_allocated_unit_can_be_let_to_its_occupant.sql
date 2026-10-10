-- An allocated unit can be let to the person allocated to it (requested
-- 9 Oct 2026: "when a tenant is allocated to a property/unit, the unit should
-- be available, not hidden, when assigning leases/rents to tenants").
--
-- ⚠️ The lease form offered `vacant_units_for_property` (0200), and vacancy is
-- "no occupant AND no live tenancy". A tenant who arrives by invitation is
-- recorded as the unit's occupant with no lease at all, and a tenant holding
-- over after expiry keeps their occupancy (decision 22). Both units read "not
-- vacant", so the one person whose tenancy most needed recording could not have
-- it recorded: their own unit was missing from the picker.
--
-- Vacancy is still one rule and is not touched (decision 22): the counters, the
-- intake window and the occupancy screen go on asking `unit_is_vacant`. The
-- lease form asks a different question, which deserves its own name: can a
-- tenancy be recorded on this unit? Yes, when no live tenancy covers it today.
-- An occupant does not stop it; it decides who the tenancy is for.
--
-- So the second half is a guard, in the database, not the form: a tenancy on
-- an occupied unit is for its occupant. Recording one for a different portal
-- tenant would put two people's names on one home, and `activate_lease` would
-- then silently move the occupancy to the newcomer. A company let (no portal
-- tenant) is allowed beside an occupant, who may be the company's own person.

set local lock_timeout = '5s';

-- The test, definer for the reason `unit_is_vacant` is: the answer must not
-- change with who is asking, or a caller who cannot see a tenancy would be
-- offered the unit under it.
create or replace function unit_is_lettable(p_unit_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from units u
     where u.id = p_unit_id
       and u.deleted_at is null
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

revoke all on function unit_is_lettable(uuid) from public, anon;
grant execute on function unit_is_lettable(uuid) to authenticated, service_role;

comment on function unit_is_lettable(uuid) is
  'Can a tenancy be recorded on this unit: not retired, and no live tenancy covering today. Unlike unit_is_vacant it ignores the occupant, who decides who the tenancy is for rather than whether there can be one. 0328.';

-- What the lease form offers. Invoker: which property's units you may read is
-- `units` RLS's business, exactly as `vacant_units_for_property` (0200).
create or replace function lettable_units_for_property(p_property_id uuid)
returns table (id uuid, label text, display_label text, occupant_user_id uuid, occupant_name text)
language sql stable
set search_path = public
as $$
  select u.id, u.label, unit_display_label(u.label, u.description),
         u.occupant_user_id,
         -- Read as the caller. A manager who cannot see the person sees the
         -- unit marked as allocated, never a name they are not entitled to.
         (select coalesce(nullif(btrim(x.full_name), ''), x.email) from users x where x.id = u.occupant_user_id)
    from units u
   where u.property_id = p_property_id
     and u.deleted_at is null
     and unit_is_lettable(u.id)
   order by u.label, u.description nulls first;
$$;

revoke all on function lettable_units_for_property(uuid) from public, anon;
grant execute on function lettable_units_for_property(uuid) to authenticated, service_role;

comment on function lettable_units_for_property(uuid) is
  'The lease form''s unit list: every unit a tenancy can be recorded on, with its occupant if one is allocated (0328). Vacancy itself is still unit_is_vacant.';

-- The guard. On every write that sets who a tenancy is for or where it is.
create or replace function leases_are_for_the_units_occupant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_occupant uuid;
begin
  if new.deleted_at is not null
     or new.status not in ('draft', 'active', 'renewed')
     or new.tenant_user_id is null then
    return new;
  end if;

  select u.occupant_user_id into v_occupant from units u where u.id = new.unit_id;
  if v_occupant is not null and v_occupant is distinct from new.tenant_user_id then
    raise exception 'This unit is allocated to someone else. Record the tenancy for the person allocated to it, or clear the unit''s occupant under People → Unit Occupancy first.';
  end if;
  return new;
end $$;

revoke all on function leases_are_for_the_units_occupant() from public, anon, authenticated, service_role;

drop trigger if exists leases_for_the_units_occupant on leases;
create trigger leases_for_the_units_occupant
  before insert or update of unit_id, tenant_user_id, status on leases
  for each row execute function leases_are_for_the_units_occupant();

-- Assertions.
do $$
begin
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('unit_is_lettable', 'lettable_units_for_property')
                and grantee in ('PUBLIC', 'anon')) then
    raise exception '0328: a lettable-unit function is callable anonymously';
  end if;
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name = 'leases_are_for_the_units_occupant'
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0328: the trigger function is executable by a client role';
  end if;
  -- Every vacant unit is lettable: the new list only ever adds to the old one.
  if exists (select 1 from units u where u.deleted_at is null
                and unit_is_vacant(u.id) and not unit_is_lettable(u.id)) then
    raise exception '0328: a vacant unit would disappear from the lease form';
  end if;
end $$;
