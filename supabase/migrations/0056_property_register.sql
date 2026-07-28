-- Day 6.75 — properties and units become manageable.
--
-- Until now the only way a property existed was a seed script. Nothing in the
-- application inserted into `properties` or `units`, though the write policies
-- had been there since 0001. Everything downstream depends on them: the asset
-- register scopes to a property, service-charge budgets apportion across its
-- units, occupancy assigns tenants to them, and the FM/PM attaché assignment
-- grants access by them.
--
-- The schema needs a little more than name + address before it can be operated,
-- and two constraints that exist to protect the service-charge apportionment.

alter table properties add column if not exists reference text;
alter table properties add column if not exists property_type text;
alter table properties add column if not exists deleted_at timestamptz;

comment on column properties.reference is
  'The client''s own code for the property, if they use one. Optional, but unique within an org where present — a duplicate reference makes reconciliation conversations ambiguous.';

create unique index if not exists properties_org_reference_uidx
  on properties (org_id, lower(reference)) where reference is not null and deleted_at is null;

alter table units add column if not exists deleted_at timestamptz;

-- ── Two constraints that protect the apportionment ─────────────────────────
--
-- 1. A unit label must be unique within its property. "Flat 2" appearing twice
--    makes every per-unit invoice ambiguous — which of the two is being billed?
--    — and silently doubles that property's share of a budget.
create unique index if not exists units_property_label_uidx
  on units (property_id, lower(label)) where deleted_at is null;

-- 2. An apportionment factor must be positive. Zero means a unit pays nothing
--    while still consuming, and the shortfall is redistributed across its
--    neighbours without anyone being told. Existing rows were checked: all
--    positive, so this validates immediately rather than NOT VALID.
alter table units drop constraint if exists units_apportionment_positive;
alter table units add constraint units_apportionment_positive
  check (apportionment_factor > 0);

-- ── Soft delete, per A3 ────────────────────────────────────────────────────
--
-- Hard-deleting a property would orphan its assets, budgets, invoices and the
-- ledger entries derived from them. The same rule already applies to assets and
-- service charges.
create or replace function block_hard_delete()
returns trigger language plpgsql as $$
begin
  raise exception
    'Records here are retired, never deleted — % is referenced by history that must stay intact. Set deleted_at instead.',
    tg_table_name;
end;
$$;

drop trigger if exists properties_no_hard_delete on properties;
create trigger properties_no_hard_delete before delete on properties
  for each row execute function block_hard_delete();

drop trigger if exists units_no_hard_delete on units;
create trigger units_no_hard_delete before delete on units
  for each row execute function block_hard_delete();

-- ── Retiring, and refusing to retire something still in use ────────────────
--
-- A property with live units, or a unit with an occupant or unpaid invoice, is
-- not "retired" — retiring it would hide the thing while leaving its
-- obligations behind. The refusal names what is in the way so it can be dealt
-- with, rather than failing on a constraint the user cannot see.
create or replace function retire_property(p_property_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p properties%rowtype;
  v_units integer;
begin
  select * into p from properties where id = p_property_id;
  if p.id is null then
    raise exception 'that property could not be found';
  end if;
  if p.org_id is distinct from current_user_org_id() and auth.uid() is not null then
    raise exception 'that property belongs to another organisation';
  end if;
  if auth.uid() is not null and not has_permission('properties.write') then
    raise exception 'you do not have permission to retire a property';
  end if;

  select count(*) into v_units from units
   where property_id = p_property_id and deleted_at is null;
  if v_units > 0 then
    raise exception
      'this property still has % active unit(s) — retire those first', v_units;
  end if;

  update properties set deleted_at = now() where id = p_property_id;
end;
$$;

create or replace function retire_unit(p_unit_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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

  if u.occupant_user_id is not null then
    raise exception 'this unit still has an occupant — unassign them first';
  end if;

  select count(*) into v_unpaid from service_charges
   where unit_id = p_unit_id and status <> 'paid' and deleted_at is null;
  if v_unpaid > 0 then
    raise exception
      'this unit has % unpaid service charge(s) — settle or write them off first', v_unpaid;
  end if;

  update units set deleted_at = now() where id = p_unit_id;
end;
$$;

revoke all on function retire_property(uuid) from public;
revoke all on function retire_unit(uuid) from public;
grant execute on function retire_property(uuid) to authenticated, service_role;
grant execute on function retire_unit(uuid) to authenticated, service_role;

-- ── Retired rows disappear from every read ─────────────────────────────────
drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      (select has_permission('properties.read_all'))
      or id in (select current_user_property_ids())
    )
  );

drop policy if exists units_select on units;
create policy units_select on units for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      occupant_user_id = auth.uid()
      or (select has_permission('properties.read_all'))
      or (select has_permission('sc.read_all'))
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists properties_viewer_select on properties;
create policy properties_viewer_select on properties for select
  using (deleted_at is null and org_id = current_user_org_id()
         and current_user_role() = 'viewer');

drop policy if exists units_viewer_select on units;
create policy units_viewer_select on units for select
  using (deleted_at is null and org_id = current_user_org_id()
         and current_user_role() = 'viewer');
