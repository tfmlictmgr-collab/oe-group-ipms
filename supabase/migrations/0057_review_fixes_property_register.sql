-- Fixes from the code review of 0056.
--
-- Two of these are live faults I introduced, and both were confirmed against the
-- database rather than reasoned about:
--
--   1. `block_hard_delete()` is SHARED. Redefining it in 0056 silently changed
--      behaviour for `assets` and `service_charges` as well.
--   2. A unit could be attached to ANOTHER ORGANISATION'S property.

-- ── 1. Restore the shared function's service-role exemption ────────────────
--
-- 0010 defined `block_hard_delete()` with `if auth.uid() is not null then raise`
-- — a soft-delete rule for USERS, with the service role deliberately exempt so
-- seeds and verification scripts can clean up after themselves.
--
-- 0056 re-declared the same function with an unconditional raise, to attach it
-- to properties and units. `create or replace` does not create a second
-- function: it replaced the one 0010's `service_charges` trigger and 0016's
-- `assets` trigger already pointed at. Confirmed live — a service-role delete of
-- an asset came back "Records here are retired, never deleted".
--
-- **A shared trigger function is an interface.** Redefining one to suit a new
-- caller changes every existing caller, and nothing in the new migration says so.

create or replace function block_hard_delete()
returns trigger language plpgsql as $$
begin
  -- The service role (auth.uid() is null) is exempt: it is how seeds and
  -- verification scripts remove their own fixtures. Every human path is refused.
  if auth.uid() is not null then
    raise exception
      'Records here are retired, never deleted — % is referenced by history that must stay intact. Set deleted_at instead.',
      tg_table_name;
  end if;
  return old;
end;
$$;

-- ── 2. A property reference cannot cross an organisation ───────────────────
--
-- `units_write` checks `org_id = current_user_org_id()`, and the row's own
-- org_id was therefore always correct — but `property_id` was never checked
-- against it. So an administrator of org A could insert a unit carrying A's
-- org_id onto B's property. Confirmed live: the POC org placed a unit on TFML's
-- "Adeola Odeku Complex".
--
-- Beyond the isolation breach it is a denial-of-service on the neighbour:
-- `units_property_label_uidx` is keyed on (property_id, label) with no org
-- component, so A could permanently occupy "Flat 2" on B's property.
--
-- Fixed relationally rather than in a policy. A composite foreign key makes the
-- invariant structural — it cannot be forgotten by the next policy author, and
-- it holds for the service role too, which an RLS check never would.

-- Repair, rather than delete, anything already mismatched — the constraint
-- below cannot be added while one exists.
--
-- The PROPERTY is authoritative about where a row belongs: if a unit or asset
-- sits on property P and P belongs to org X, then it belongs to org X. Deleting
-- was the first instinct and is wrong twice over — it discards a real record,
-- and a unit that has ever been invoiced is referenced by `service_charges`, so
-- the delete would fail and abort this whole migration before the
-- `block_hard_delete()` restoration above had committed.
update units u
   set org_id = p.org_id
  from properties p
 where p.id = u.property_id
   and p.org_id is distinct from u.org_id;

update assets a
   set org_id = p.org_id
  from properties p
 where p.id = a.property_id
   and p.org_id is distinct from a.org_id;

create unique index if not exists properties_id_org_uidx on properties (id, org_id);

alter table units drop constraint if exists units_property_same_org_fk;
alter table units add constraint units_property_same_org_fk
  foreign key (property_id, org_id) references properties (id, org_id);

-- Assets carry a property_id too and had the same gap, though nothing had
-- exploited it. Same fix, for the same reason.
alter table assets drop constraint if exists assets_property_same_org_fk;
alter table assets add constraint assets_property_same_org_fk
  foreign key (property_id, org_id) references properties (id, org_id);

comment on constraint units_property_same_org_fk on units is
  'A unit cannot point at another organisation''s property. Structural, so it survives a policy rewrite and applies to the service role too.';

-- ── 3. Retiring a property must not orphan its asset register ──────────────
--
-- `retire_property` refused while active UNITS remained but ignored assets
-- entirely — so a property carrying plant and equipment could be retired,
-- orphaning exactly the records the soft-delete rule exists to protect.
create or replace function retire_property(p_property_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p properties%rowtype;
  v_units integer;
  v_assets integer;
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

  select count(*) into v_assets from assets
   where property_id = p_property_id and deleted_at is null;
  if v_assets > 0 then
    raise exception
      'this property still has % asset(s) on the register — reassign or archive them first',
      v_assets;
  end if;

  update properties set deleted_at = now() where id = p_property_id;
end;
$$;

revoke all on function retire_property(uuid) from public;
grant execute on function retire_property(uuid) to authenticated, service_role;
