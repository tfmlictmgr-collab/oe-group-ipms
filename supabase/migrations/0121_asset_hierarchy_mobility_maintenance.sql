-- Asset register: assemblies, mobility, and a maintenance strategy.
--
-- From `docs/ASSET_CLASSIFICATION_AND_SCOPE.md` (PC2). Part 1 of that document
-- is confirmation — the existing taxonomy and the two-tier RLS scoping are
-- correct and untouched here. These are its Part 2: three additive gaps a full
-- FM register needs. None touches RLS, the payment gate, or any money path.
--
-- Verified before writing, rather than taken on trust:
--   * `meters` / `sensor_readings` / `ml_features` genuinely do not exist, so
--     the usage-metered strategy below really is a Phase-2 seam and not a
--     regression (CLAUDE.md B9).
--   * `audit_asset_write` (AFTER INSERT OR UPDATE) genuinely exists, which is
--     what lets 2b add no new machinery: a relocation is already audited as an
--     ordinary `property_id` change.

-- ── 2a. Assemblies ────────────────────────────────────────────────────────
--
-- Every asset was a flat, independent row. A chiller plant made of a chiller,
-- its AHUs and ducting had no way to say those belong together, so no
-- system-level rollup was possible — "total spend on the HVAC plant" could
-- only ever be "total spend on one unit of it".
alter table assets add column if not exists parent_asset_id uuid references assets(id);

create or replace function assets_parent_is_valid()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.parent_asset_id is null then return new; end if;

  if new.parent_asset_id = new.id then
    raise exception 'an asset cannot be its own parent';
  end if;

  -- Same org AND same property. A component that lives on a different
  -- property is not a component; it is a different asset that happens to be
  -- the same model, and letting the two merge would make a property's own
  -- register lie about what is on it.
  if not exists (
    select 1 from assets p
     where p.id = new.parent_asset_id
       and p.org_id = new.org_id
       and p.property_id = new.property_id
  ) then
    raise exception 'the parent asset must be on the same property, in the same organisation';
  end if;

  -- Walk up from the proposed parent and refuse if we arrive back at this
  -- row. On INSERT this can never fire (the row does not exist yet, so
  -- nothing can already point at it) — it is UPDATE that can close a loop,
  -- by re-parenting an ancestor under its own descendant.
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

  return new;
end;
$$;

drop trigger if exists assets_parent_valid on assets;
create trigger assets_parent_valid
  before insert or update of parent_asset_id on assets
  for each row execute function assets_parent_is_valid();

create index if not exists assets_parent_idx
  on assets (parent_asset_id) where parent_asset_id is not null;

comment on column assets.parent_asset_id is
  'The assembly this asset is a component of, when it is one. Constrained to the same org AND property by trigger, and guarded against cycles -- an asset cannot become a component of itself, directly or through its own descendants.';

-- ── 2b. Fixed vs movable ──────────────────────────────────────────────────
--
-- A lift is structurally part of a building; a portable generator may
-- legitimately move between properties in the same org. Nothing distinguished
-- them, so a relocation had no right or wrong path.
--
-- ⚠️ Deliberately permissive at the database. This states INTENT and gates the
-- UI ("Reassign" offered only on a movable asset); it does not forbid an
-- administrator correcting a miscategorised row. That matches how `status` and
-- `condition` already behave on this table — advisory, not DB-locked — and a
-- hard constraint here would mean a mislabelled lift could never be fixed.
-- The move itself needs no new machinery: `audit_asset_write` already records
-- a `property_id` change like any other.
alter table assets add column if not exists mobility text
  not null default 'fixed' check (mobility in ('fixed', 'movable'));

comment on column assets.mobility is
  'fixed: structurally part of this property, never reassigned. movable: portable equipment that may transfer between properties in the same org -- a reassignment updates property_id and is audited like any other change. Advisory, not enforced: an administrator can still correct a miscategorised asset.';

-- ── 2c. Maintenance strategy ──────────────────────────────────────────────
--
-- `last_serviced_at` / `next_service_due` were single dates with no statement
-- of HOW maintenance is triggered — so a quarterly-serviced chiller and a
-- fix-on-failure door closer were indistinguishable until someone read the
-- dates and inferred it.
alter table assets add column if not exists maintenance_strategy text
  not null default 'reactive'
  check (maintenance_strategy in ('reactive', 'calendar', 'usage'));

alter table assets add column if not exists service_interval_days integer
  check (service_interval_days is null or service_interval_days > 0);

-- A calendar strategy with no interval is not a strategy, it is a label. Added
-- as a validating constraint because every existing row defaults to
-- 'reactive' and therefore already satisfies it.
alter table assets drop constraint if exists assets_calendar_needs_interval;
alter table assets add constraint assets_calendar_needs_interval
  check (maintenance_strategy <> 'calendar' or service_interval_days is not null);

comment on column assets.maintenance_strategy is
  'reactive: serviced only on failure or report -- the default. calendar: serviced on a fixed interval (service_interval_days), so next_service_due can be recomputed after each service. usage: meter/hours-based -- PHASE 2. The value exists in the check constraint so the column never needs widening when meters/sensor_readings land, but nothing sets it and no UI offers it until they do.';

comment on column assets.service_interval_days is
  'Days between services on a calendar strategy. Required when maintenance_strategy = calendar (assets_calendar_needs_interval), null otherwise.';
