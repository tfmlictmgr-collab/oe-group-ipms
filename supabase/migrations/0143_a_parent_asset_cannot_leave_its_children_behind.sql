-- Asset assemblies: the same-property invariant now also holds when the
-- PARENT relocates, not just when a component is (re)assigned to one.
--
-- `assets_parent_is_valid()` (0121) already enforces "same org AND same
-- property" between an asset and its `parent_asset_id` -- but only as a
-- trigger `before insert or update of parent_asset_id`. It never fired when
-- `property_id` changed on either side of an existing assembly relationship
-- while `parent_asset_id` itself was left alone. `assets_update` RLS permits
-- exactly that write (an admin, or an FM/PM staked to both properties, may
-- `UPDATE assets SET property_id = ...` on any asset they can already touch),
-- so a parent's own relocation could silently strand its components on the
-- property it just left -- the exact "a property's own register lies about
-- what is on it" outcome 0121's own comment was written to prevent, now
-- reachable through the one write path its trigger didn't watch.
-- (Build audit 0806-M1.)
--
-- Not currently reachable through the app: `app/dashboard/assets/actions.ts`
-- has no update/edit action for an existing asset at all (create, CSV-import,
-- archive only) -- `mobility` and `parent_asset_id` are set at creation and
-- never revisited. This closes the gap at the database layer ahead of that
-- UI existing, per this build's own "the database is the boundary" ethos.
--
-- Known limitation, left for whoever builds the relocate UI: a single
-- statement that moves a parent AND all of its children together (rather
-- than one row at a time) will still be refused by the check below, because
-- a BEFORE ROW trigger evaluating `exists (select ... from assets c ...)`
-- reads the table as of the start of the statement -- it cannot see another
-- row's new value from later in the same multi-row UPDATE. That is the safe
-- direction to be wrong in (over-refuse a legitimate batch move, never
-- silently allow a stray component) but it does mean "move the whole
-- assembly to a new property" will need either a per-row sequenced update
-- (children first, parent last) or a deliberately different mechanism, once
-- that feature exists. Flagging now rather than leaving it to be rediscovered
-- the hard way.

create or replace function assets_parent_is_valid()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Case 1 -- this row declares a parent. Unchanged from 0121, except it is
  -- now re-run any time this trigger fires, including when only property_id
  -- changed and parent_asset_id did not -- see the trigger definition below.
  if new.parent_asset_id is not null then
    if new.parent_asset_id = new.id then
      raise exception 'an asset cannot be its own parent';
    end if;

    if not exists (
      select 1 from assets p
       where p.id = new.parent_asset_id
         and p.org_id = new.org_id
         and p.property_id = new.property_id
    ) then
      raise exception 'the parent asset must be on the same property, in the same organisation';
    end if;

    if exists (
      with recursive up as (
        select id, parent_asset_id from assets where id = new.parent_asset_id
        union all
        select a.id, a.parent_asset_id from assets a join up on a.id = up.parent_asset_id
      )
      select 1 from up where id = new.id
    ) then
      raise exception 'that would make the asset a component of itself';
    end if;
  end if;

  -- Case 2 (new) -- this row's OWN property just changed, and it is itself a
  -- parent to other assets. Relocating it does not touch its children's rows,
  -- so their own trigger firing was never going to catch this; this is the
  -- one direction Case 1 cannot see on its own.
  if tg_op = 'UPDATE' and new.property_id is distinct from old.property_id then
    if exists (
      select 1 from assets c
       where c.parent_asset_id = new.id
         and c.property_id is distinct from new.property_id
    ) then
      raise exception 'this asset has components on its previous property -- relocate or reassign them first';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists assets_parent_valid on assets;
create trigger assets_parent_valid
  before insert or update of parent_asset_id, property_id on assets
  for each row execute function assets_parent_is_valid();
