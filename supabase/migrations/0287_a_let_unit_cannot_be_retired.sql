-- 0287 — A let unit cannot be retired, and retiring one leaves a trace.
--
-- Found 11 Sept 2026 on staging. The OEA administrator drafted four tenancies on
-- units 3 and 9 of Afreximbank African Trade Centre (none of them naming a
-- tenant), activated and renewed them, then retired units 3–10 through the
-- Units panel, eight clicks in 28 seconds. `retire_unit` said yes to all
-- eight. Units 3 and 9 disappeared, and so did their four live tenancies,
-- because `units_select` filters `deleted_at is null` and both `rent_roll` and
-- `tenancy_schedule` inner-join units. They vanished from Leases & Rent, the
-- tenancy schedule and People → Directory, and they stayed live. One of them
-- carries an unpaid ₦352,500 rent demand, and `raise-rent-demands` goes on
-- billing tenancies it can no longer show anyone.
--
-- ⚠️ Why `retire_unit` let them through. It was written in `0056`, before leases
-- existed (`0090`), and its only test for "is somebody here" is
-- `occupant_user_id`. Decision 22 already records that a company let has no
-- portal user and that `activate_lease` skips the occupant in that case, which
-- is exactly why `unit_is_vacant` asks both questions. `retire_unit` was the
-- consumer of "vacant" that never got re-read: the fourth, after the counters,
-- the intake window and the lease picker. Every one of the four orphaned leases
-- has `tenant_user_id` NULL, so the unit read "no occupant" and the retirement
-- went ahead.
--
-- Write paths that set `units.deleted_at` (checked, not assumed):
--   • `retire_unit(uuid)`: the Units panel's Retire button, via
--     `retireUnit` in app/dashboard/properties/actions.ts. Tested occupant +
--     unpaid service charges, and no tenancy.
--   • A direct REST PATCH. `authenticated` holds UPDATE on `units.deleted_at`,
--     and `units_update` admits `properties.write` OR `units.assign_occupant`.
--     So a role that can only assign occupants could still retire a unit with a
--     `Prefer: return=minimal` PATCH, and nothing tested anything at all.
--   • Nothing else. `retire_property` writes `properties.deleted_at` only, and
--     refuses while any unit is live.
-- So the rule goes on the TABLE, where both paths (and any future third one)
-- have to pass through it. It does not go in `retire_unit`, which only one of
-- them calls.
--
-- ⚠️ The trigger function is SECURITY DEFINER on purpose. Run as the caller, its
-- lease lookup would be filtered by `leases_select`, so a caller who cannot
-- SEE a tenancy would be allowed to retire the unit under it. That is the same
-- false pass decision 37 recorded, where `0225`'s trigger ran its SELECT as the
-- caller and answered "that unit does not exist". A guard that checks less than
-- the table holds does not guard anything. The function only reads and raises.
--
-- The reverse door is closed in this migration as well. `activate_lease` and
-- `renew_lease` are SECURITY DEFINER and never ask whether the unit is retired,
-- so without a guard on `leases` a live tenancy could still be put onto a
-- retired unit from that side. The assertion at the bottom of this file would
-- then describe only the day the migration ran. `0225`'s
-- `leases_unit_on_property` does not cover this: it runs its SELECT as the
-- caller (which a definer is not), and it fires only when `unit_id` or
-- `property_id` changes, never on a status change.
--
-- Repair (decided with the user on 11 Sept 2026): restore units 3 and 9 and do
-- NOT end the tenancies. Restoring loses nothing, can be undone, and puts all
-- four tenancies back on the screens where OEA can name the tenant or end the
-- tenancy with a person on the record. Ending them from a migration would have
-- recorded a lettings act with no one behind it. Units 4–8 and 10 hold nothing
-- and stay retired. The restore is keyed on these two ids and is a no-op on
-- every world where they do not exist.

-- ── 1. Retiring and restoring a unit are audited ───────────────────────────
--
-- Until now only occupancy changes on `units` were audited, so an administrator
-- could remove eight units from the register and the trail showed nothing. It
-- is created FIRST, so the repair in step 4 is recorded like any other restore.
drop trigger if exists audit_unit_retired on units;
create trigger audit_unit_retired
  after update of deleted_at on units
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function log_audit('unit.retired');

drop trigger if exists audit_unit_restored on units;
create trigger audit_unit_restored
  after update of deleted_at on units
  for each row
  when (old.deleted_at is not null and new.deleted_at is null)
  execute function log_audit('unit.restored');

-- ── 2. A unit holding a tenancy or an occupant cannot be retired ───────────
--
-- "Live" means `status in ('active','renewed') and deleted_at is null`, the
-- predicate `leases_no_overlap` and `end_tenancy` use. It is deliberately NOT
-- date-bounded the way `unit_is_vacant` is. A tenancy that starts in 2028 is
-- still a commitment on this unit, and a renewed tenancy whose end date has
-- passed is still one `end_tenancy` accepts. Each of them is one click from
-- being dealt with properly, and retiring the unit would put that click out of
-- reach.
--
-- 📌 The message contains no colon. `retireUnit` shows
-- `error.message.replace(/^.*?:\s*/, "")`, which cuts everything up to the
-- first colon. A date written as 11:29, or "Note: ...", would lose the start of
-- the sentence.
create or replace function refuse_retiring_a_let_unit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name   text;
  v_live   integer;
  v_until  date;
begin
  select count(*), max(l.end_date)
    into v_live, v_until
    from leases l
   where l.unit_id = new.id
     and l.deleted_at is null
     and l.status in ('active', 'renewed');

  if v_live = 0 and new.occupant_user_id is null then
    return new;
  end if;

  select new.label
         || coalesce(' (' || nullif(trim(new.description), '') || ')', '')
         || coalesce(' at ' || p.name, '')
    into v_name
    from properties p
   where p.id = new.property_id;
  v_name := coalesce(v_name, new.label);

  if v_live > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '%s still holds %s live %s, running to %s. End the tenancy first (Leases & Rent, then End tenancy) and retire the unit afterwards. Retiring it now would hide a tenancy that can still be billed.',
        v_name, v_live,
        case when v_live = 1 then 'tenancy' else 'tenancies' end,
        to_char(v_until, 'FMDD Mon YYYY'));
  end if;

  raise exception using
    errcode = 'P0001',
    message = format(
      '%s still has an occupant recorded. Record them as moved out (clear the occupant on the Units panel) before retiring it, so nobody is left attached to a unit that is no longer on the register.',
      v_name);
end;
$fn$;

comment on function refuse_retiring_a_let_unit() is
  'BEFORE UPDATE OF deleted_at on units. Refuses to retire a unit that holds a live tenancy (active/renewed, not deleted) or a recorded occupant, and names end_tenancy as the remedy. Definer so that no tenancy is hidden from it by the caller''s RLS (0287).';

revoke all on function refuse_retiring_a_let_unit() from public, anon, authenticated, service_role;

drop trigger if exists units_refuse_retiring_a_let_unit on units;
create trigger units_refuse_retiring_a_let_unit
  before update of deleted_at on units
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function refuse_retiring_a_let_unit();

-- ── 3. A retired unit cannot take a live tenancy ───────────────────────────
--
-- Fires whenever a lease becomes, or is written as, live: on insert, on a status
-- change (`activate_lease`, and `renew_lease` on both of its rows), on a unit
-- change, and on un-deleting a lease.
create or replace function refuse_letting_a_retired_unit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.deleted_at is null
     and new.status in ('active', 'renewed')
     and exists (select 1 from units u where u.id = new.unit_id and u.deleted_at is not null)
  then
    raise exception using
      errcode = 'P0001',
      message = 'That unit has been retired from the property''s register, so it cannot hold a live tenancy. Let a unit that is still on the register, or have an administrator restore this one first.';
  end if;
  return new;
end;
$fn$;

comment on function refuse_letting_a_retired_unit() is
  'BEFORE INSERT/UPDATE on leases. Refuses to make a tenancy live on a retired unit, the reverse of refuse_retiring_a_let_unit, so that neither activate_lease nor renew_lease can reopen what 0287 closes (0287).';

revoke all on function refuse_letting_a_retired_unit() from public, anon, authenticated, service_role;

drop trigger if exists leases_refuse_a_retired_unit on leases;
create trigger leases_refuse_a_retired_unit
  before insert or update of status, unit_id, deleted_at on leases
  for each row
  execute function refuse_letting_a_retired_unit();

-- ── 4. `retire_unit` stops giving the wrong remedy ─────────────────────────
--
-- Rebuilt from `pg_get_functiondef` (0183). The only change is that its own
-- occupant check is removed. That check fired before the trigger could, and it
-- told the person to "unassign them first". For a tenant under a lease that
-- advice is wrong, and following it produces decision 22's "occupancy and
-- tenancy disagreeing": the occupant is cleared, the lease is still live, and
-- the trigger refuses anyway. The trigger now says which remedy applies.
-- `end_tenancy` is right when there is a tenancy, and clearing the occupant is
-- right when there is none. The unpaid service-charge check stays here,
-- unchanged, since it is a condition only this function tests.
create or replace function public.retire_unit(p_unit_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  u units%rowtype;
  v_unpaid integer;
begin
  select * into u from units where id = p_unit_id;
  if u.id is null then
    raise exception 'that unit could not be found';
  end if;
  if u.org_id is distinct from current_user_org_id() and auth.uid() is not null then
    raise exception 'that unit belongs to another organisation';
  end if;
  if auth.uid() is not null and not has_permission('properties.write') then
    raise exception 'you do not have permission to retire a unit';
  end if;

  -- An occupant or a live tenancy is refused by `units_refuse_retiring_a_let_unit`
  -- (0287), which every write path passes through and which names the right
  -- remedy for each. It is not repeated here.

  select count(*) into v_unpaid from service_charges
   where unit_id = p_unit_id and status <> 'paid' and deleted_at is null;
  if v_unpaid > 0 then
    raise exception
      'this unit has % unpaid service charge(s) — settle or write them off first', v_unpaid;
  end if;

  update units set deleted_at = now() where id = p_unit_id;
end;
$function$;

revoke all on function retire_unit(uuid) from public, anon, authenticated, service_role;
grant execute on function retire_unit(uuid) to authenticated, service_role;

-- ── 5. Repair: restore the two units that were retired over live tenancies ──
do $$
declare
  v_ids uuid[] := array[
    '30e0293b-e0c1-40d1-885b-b7126f3afb8c',   -- Open-plan Office (9), Afreximbank ATC
    '86515c3c-3138-487a-98b9-cb24879199bb'    -- Open-plan Office (3), Afreximbank ATC
  ]::uuid[];
  r record;
begin
  for r in
    select u.id, u.org_id, u.deleted_at,
           array_agg(l.id order by l.start_date) as leases
      from units u
      join leases l on l.unit_id = u.id
                   and l.deleted_at is null
                   and l.status in ('active', 'renewed')
     where u.id = any(v_ids)
       and u.deleted_at is not null
     group by u.id, u.org_id, u.deleted_at
  loop
    update units set deleted_at = null where id = r.id;   -- audited as unit.restored

    -- The trigger row shows WHAT changed. This one shows WHY, because a
    -- migration has no session and the trigger row will name no actor.
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
    values (
      r.org_id, null, 'unit.restore_reason', 'units', r.id,
      jsonb_build_object('deleted_at', r.deleted_at),
      jsonb_build_object(
        'deleted_at', null,
        'reason', 'Retired on 11 Sept 2026 while holding live tenancies, which then disappeared from Leases & Rent, the tenancy schedule and the Directory. Restored by migration 0287, as decided with the user, so the tenancies can be named or ended from the product.',
        'live_leases', to_jsonb(r.leases))
    );
    raise notice '0287: restored unit % (% live tenancies)', r.id, array_length(r.leases, 1);
  end loop;
end $$;

-- ── 6. Assertions ──────────────────────────────────────────────────────────
do $$
declare
  v_orphans text;
  v_unit    uuid;
  v_lease   uuid;
  v_def     text;
begin
  -- The invariant, on whatever world this runs against.
  select string_agg(format('unit %s / lease %s (%s)', u.id, l.id, l.status), '; ')
    into v_orphans
    from units u
    join leases l on l.unit_id = u.id
   where u.deleted_at is not null
     and l.deleted_at is null
     and l.status in ('active', 'renewed');
  if v_orphans is not null then
    raise exception '0287: a retired unit still holds a live tenancy (%). Decide the repair with a person first; do not widen the restore above.', v_orphans;
  end if;

  select string_agg(u.id::text, ', ') into v_orphans
    from units u where u.deleted_at is not null and u.occupant_user_id is not null;
  if v_orphans is not null then
    raise exception '0287: a retired unit still has an occupant recorded (%)', v_orphans;
  end if;

  -- The refusal, proved. Any let unit will do. The attempt is made inside a
  -- sub-block so whatever happens is rolled back.
  select l.unit_id into v_unit
    from leases l join units u on u.id = l.unit_id
   where u.deleted_at is null and l.deleted_at is null and l.status in ('active', 'renewed')
   limit 1;
  if v_unit is not null then
    begin
      update units set deleted_at = now() where id = v_unit;
      raise exception '0287-no-refusal';
    exception when others then
      if sqlerrm not like '%End the tenancy first%' then
        raise exception '0287: retiring a let unit was not refused as designed (got "%")', sqlerrm;
      end if;
    end;
  else
    raise notice '0287: no live tenancy on this world, so the retire refusal was not exercised';
  end if;

  -- The reverse door. Take a lease that is not live, on a unit that nothing
  -- holds, retire the unit, then try to make the lease live.
  select l.id, l.unit_id into v_lease, v_unit
    from leases l join units u on u.id = l.unit_id
   where l.deleted_at is null and l.status in ('draft', 'expired', 'terminated')
     and u.deleted_at is null and u.occupant_user_id is null
     and not exists (select 1 from leases x where x.unit_id = u.id and x.deleted_at is null
                        and x.status in ('active', 'renewed'))
   limit 1;
  if v_lease is not null then
    begin
      update units set deleted_at = now() where id = v_unit;
      update leases set status = 'active' where id = v_lease;
      raise exception '0287-no-refusal';
    exception when others then
      if sqlerrm not like '%cannot hold a live tenancy%' then
        raise exception '0287: a retired unit took a live tenancy (got "%")', sqlerrm;
      end if;
    end;
  else
    raise notice '0287: no dormant lease on this world, so the reverse refusal was not exercised';
  end if;

  -- The rebuild moved the body and did not retype it (0183, 0277).
  v_def := pg_get_functiondef('public.retire_unit(uuid)'::regprocedure);
  if v_def not like '%unpaid service charge(s)%' or v_def not like '%has_permission(''properties.write'')%' then
    raise exception '0287: retire_unit lost a check it had before the rebuild';
  end if;
  if v_def like '%unassign them first%' then
    raise exception '0287: retire_unit still gives the unassign remedy before the trigger can speak';
  end if;

  -- Grants. The two trigger functions are reachable by nobody. retire_unit is
  -- reachable by a signed-in caller and never by anon.
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('refuse_retiring_a_let_unit', 'refuse_letting_a_retired_unit')
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0287: a trigger function is executable by a client role';
  end if;
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public' and routine_name = 'retire_unit'
                and grantee in ('PUBLIC', 'anon')) then
    raise exception '0287: retire_unit is callable anonymously';
  end if;
  if not has_function_privilege('authenticated', 'public.retire_unit(uuid)', 'EXECUTE') then
    raise exception '0287: retire_unit is no longer callable by a signed-in user';
  end if;

  -- All four triggers exist.
  if (select count(*) from pg_trigger
       where not tgisinternal
         and tgname in ('audit_unit_retired', 'audit_unit_restored',
                        'units_refuse_retiring_a_let_unit', 'leases_refuse_a_retired_unit')) <> 4 then
    raise exception '0287: a trigger is missing';
  end if;
end $$;
