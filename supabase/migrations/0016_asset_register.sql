-- ASSET REGISTER (Phase 1 core) — the spine of FM/PM operations.
--
-- Closes a real gap: CLAUDE.md B9 promised `assets` as a Day-1 stub and B2
-- Module 1 lets tenants raise "asset issues", but no assets table existed.
--
-- Hierarchy: org → property → (optional) unit → asset. An asset always belongs
-- to a property (that is what drives property-scoped access); the unit is
-- optional because plant/equipment is often building-wide, not unit-specific.
--
-- Written by the Facilities Manager (TFML) / Properties Manager (OEA) — the same
-- `facility_manager` role; only the display label differs per brand.
--
-- Phase 2 seams deliberately left: maintenance schedules, condition surveys,
-- QR/barcode tags and IoT meters all hang off asset_id without re-architecture.

-- ── Controlled vocabularies ────────────────────────────────────────────────
-- Enums (not free text) so bulk imports stay clean and analytics can group.
create type asset_category as enum (
  'hvac',              -- air-conditioning, chillers, AHUs
  'electrical',        -- panels, DBs, wiring, lighting
  'power_generation',  -- generators, inverters, solar, UPS  (Nigeria-critical)
  'plumbing',          -- pumps, tanks, pipework, water treatment
  'fire_safety',       -- alarms, extinguishers, sprinklers, hydrants
  'security',          -- CCTV, access control, barriers, intercom
  'lifts_escalators',
  'building_fabric',   -- roof, doors, windows, structure, finishes
  'furniture_fittings',
  'it_communications', -- servers, network, telephony
  'grounds_external',  -- landscaping, drainage, car park, fencing
  'cleaning_waste',
  'other'
);

create type asset_condition as enum ('new', 'good', 'fair', 'poor', 'unserviceable');

-- Drives maintenance priority and the SLA a failure inherits.
create type asset_criticality as enum ('critical', 'high', 'medium', 'low');

create type asset_status as enum (
  'in_service', 'under_maintenance', 'standby', 'decommissioned', 'disposed'
);

-- ── Assets ─────────────────────────────────────────────────────────────────
create table assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  property_id uuid not null references properties(id),
  unit_id uuid references units(id),          -- optional: building-wide plant has none

  -- Identity
  asset_tag text not null,                    -- org-unique human reference, e.g. GEN-IKJ-001
  name text not null,
  category asset_category not null default 'other',
  description text,

  -- Make / model / serial — the identification triad every FM register needs
  manufacturer text,
  model text,
  serial_number text,

  -- Where it physically is, beyond property/unit (e.g. "Roof plant room, Level 3")
  location_detail text,

  -- Lifecycle
  status asset_status not null default 'in_service',
  condition asset_condition not null default 'good',
  criticality asset_criticality not null default 'medium',
  purchase_date date,
  commissioned_date date,
  warranty_expiry date,
  expected_life_years integer check (expected_life_years is null or expected_life_years between 0 and 200),

  -- Commercials (Naira). Numeric, never float — money must not drift.
  purchase_cost numeric(14,2) check (purchase_cost is null or purchase_cost >= 0),
  replacement_cost numeric(14,2) check (replacement_cost is null or replacement_cost >= 0),

  -- Responsibility
  assigned_vendor_id uuid references vendors(id),   -- who maintains it
  custodian_user_id uuid references users(id),      -- who is accountable in-house

  -- Phase-2 seams (populated later; present now so no re-architecture is needed)
  qr_code text,                                -- printed tag payload
  last_serviced_at date,
  next_service_due date,

  notes text,
  photo_url text,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                        -- soft-delete only (A3 guardrail)
);

-- An asset tag is unique per org (not globally) — two orgs may both use "GEN-001".
-- Partial index so a soft-deleted tag can be reused.
create unique index assets_org_tag_uidx
  on assets (org_id, lower(asset_tag)) where deleted_at is null;

create index assets_org_idx          on assets (org_id);
create index assets_property_idx     on assets (property_id);
create index assets_unit_idx         on assets (unit_id);
create index assets_category_idx     on assets (org_id, category);
create index assets_status_idx       on assets (org_id, status);
create index assets_next_service_idx on assets (org_id, next_service_due)
  where deleted_at is null and next_service_due is not null;

-- ── Row-level security ─────────────────────────────────────────────────────
alter table assets enable row level security;

-- READ: org-scoped always. Admin/finance see the whole org; FM/PM and owners see
-- only assets on properties they are staked to; everyone else sees none.
create policy assets_select on assets for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    )
  );

-- WRITE: the FM/PM owns the register for their properties; admin org-wide.
-- Vendors, tenants, owners and ops staff cannot create or edit assets.
create policy assets_insert on assets for insert
  with check (
    org_id = current_user_org_id()
    and (
      current_user_role() = 'admin'
      or (
        current_user_role() = 'facility_manager'
        and property_id in (select current_user_property_ids())
      )
    )
  );

create policy assets_update on assets for update
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = 'admin'
      or (
        current_user_role() = 'facility_manager'
        and property_id in (select current_user_property_ids())
      )
    )
  )
  with check (
    org_id = current_user_org_id()
    and (
      current_user_role() = 'admin'
      or (
        current_user_role() = 'facility_manager'
        and property_id in (select current_user_property_ids())
      )
    )
  );

-- No delete policy: assets are soft-deleted by setting deleted_at. The guard
-- below blocks a hard DELETE by any authenticated user (service role exempt).
create trigger assets_no_hard_delete before delete on assets
  for each row execute function block_hard_delete();

-- ── Integrity ──────────────────────────────────────────────────────────────
-- A unit must belong to the same property as its asset, otherwise an asset could
-- be filed under property A while pointing at a unit of property B — which would
-- leak it into the wrong FM's property-scoped view.
create or replace function assert_asset_unit_matches_property()
returns trigger language plpgsql as $$
declare u_property uuid;
begin
  if new.unit_id is null then return new; end if;
  select property_id into u_property from units where id = new.unit_id;
  if u_property is distinct from new.property_id then
    raise exception 'unit % does not belong to property %', new.unit_id, new.property_id;
  end if;
  return new;
end;
$$;

create trigger assets_unit_property_match
  before insert or update on assets
  for each row execute function assert_asset_unit_matches_property();

-- Keep updated_at honest.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger assets_touch_updated_at
  before update on assets
  for each row execute function touch_updated_at();

-- ── Audit ──────────────────────────────────────────────────────────────────
-- The register is a controlled record: every create/edit/soft-delete is logged.
create trigger audit_asset_write
  after insert or update on assets
  for each row execute function log_audit('asset.write');

-- ── Link tickets to the asset that failed (B2 Module 1 "asset issues") ─────
alter table tickets add column if not exists asset_id uuid references assets(id);
create index if not exists tickets_asset_idx on tickets (asset_id);
