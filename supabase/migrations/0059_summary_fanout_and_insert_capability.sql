-- Two fixes, one of them a fault I introduced while fixing something else.
--
-- ── 1. `property_summary` multiplied every count ──────────────────────────
--
-- 0058 left-joined BOTH `units` AND `assets` to `properties` in one grouped
-- query. That is a cartesian product per property: a property with 6 units and
-- 5 assets produced 30 rows, so `unit_count` read 30, `occupied_count` was
-- multiplied the same way, and `total_factor` came back five times too large.
--
-- Measured on live data before the fix:
--   Lekki Gardens Estate — view said 30 units, actually 6; factor 3400 vs 680
--   Ikoyi Heights        — view said 8 units, actually 4
--
-- The JavaScript it replaced was CORRECT. It was only at risk of truncation
-- past PostgREST's 1000-row cap; this made it wrong at any size, which is
-- strictly worse. **Fixing a scaling risk by introducing a correctness bug is
-- not a fix** — and a fan-out is invisible until a property has two of the
-- second thing, which is why the dev data hid it for one property and not
-- another.
--
-- Scalar subqueries instead of joins: each aggregate is computed independently,
-- so no table can multiply another.

create or replace view property_summary
with (security_invoker = on) as
  select
    p.id,
    p.org_id,
    p.name,
    p.reference,
    p.address,
    p.property_type,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null)              as unit_count,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null
        and u.occupant_user_id is not null)                             as occupied_count,
    (select coalesce(sum(u.apportionment_factor), 0) from units u
      where u.property_id = p.id and u.deleted_at is null)              as total_factor,
    (select count(*) from assets a
      where a.property_id = p.id and a.deleted_at is null)              as asset_count
  from properties p
  where p.deleted_at is null;

comment on view property_summary is
  'Per-property counts for the portfolio list. Scalar subqueries, NOT joins — joining units and assets together fans out and multiplies both counts. security_invoker, so the caller''s RLS still decides what is included.';

grant select on property_summary to authenticated;

-- ── 2. Creating a unit is portfolio management, not occupancy ─────────────
--
-- `units_insert` admitted either `properties.write` OR `units.assign_occupant`,
-- so a role granted only occupancy could ADD units with any apportionment
-- factor it liked — diluting every existing unit's share. The occupancy /
-- pricing split added on the update path did not cover this.
--
-- Occupancy changes one column on a unit that already exists. Bringing a unit
-- into existence, with the weighting that decides what it pays, is the other
-- power entirely.
drop policy if exists units_insert on units;
create policy units_insert on units for insert
  with check (
    org_id = current_user_org_id()
    and (select has_permission('properties.write'))
  );

-- UPDATE still admits either: assign_occupant needs to write occupant_user_id,
-- and the application splits which COLUMNS each capability may touch (RLS is
-- row-level, so the column split has to live there).
drop policy if exists units_update on units;
create policy units_update on units for update
  using (
    org_id = current_user_org_id()
    and (
      (select has_permission('properties.write'))
      or (select has_permission('units.assign_occupant'))
    )
  )
  with check (
    org_id = current_user_org_id()
    and (
      (select has_permission('properties.write'))
      or (select has_permission('units.assign_occupant'))
    )
  );

drop policy if exists units_delete on units;
create policy units_delete on units for delete
  using (org_id = current_user_org_id() and (select has_permission('properties.write')));
