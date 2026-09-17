-- Corrects the Phase-2 tagging seam: QR was too narrow.
--
-- An asset in the field commonly carries SEVERAL machine-readable identifiers:
--   • the OEM's own barcode on the rating plate,
--   • a legacy tag inherited from a previous system or spreadsheet,
--   • the organisation's own printed label (QR or 1D barcode),
--   • increasingly RFID/NFC on high-value plant.
-- A single assets.qr_code column could hold exactly one, and would have forced
-- re-labelling of equipment that is already tagged. The scan workflow is
-- "scan whatever is on the asset -> find the asset", so identifiers belong in a
-- lookup table indexed by value, not in a column.
--
-- assets.asset_tag stays as the HUMAN reference (GEN-IKJ-001). This table holds
-- what a scanner reads.

create type asset_identifier_kind as enum (
  'qr',          -- 2D, phone-camera scannable
  'barcode_1d',  -- Code 128 / Code 39 / EAN — legacy scanners, printed labels
  'rfid',
  'nfc',
  'oem_serial',  -- manufacturer's own barcode on the rating plate
  'legacy',      -- tag carried over from a previous system
  'other'
);

create table asset_identifiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  kind asset_identifier_kind not null default 'qr',
  value text not null,
  label text,                    -- e.g. "Rating plate", "Door frame label"
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- A scanned value must resolve to exactly one asset within an org. Two orgs may
-- legitimately hold the same OEM barcode, so uniqueness is per-org, not global.
create unique index asset_identifiers_org_value_uidx
  on asset_identifiers (org_id, lower(value));
create index asset_identifiers_asset_idx on asset_identifiers (asset_id);
-- Scan lookup path: value -> asset.
create index asset_identifiers_value_idx on asset_identifiers (org_id, lower(value));

alter table asset_identifiers enable row level security;

-- Identifiers inherit the asset's visibility: if you cannot see the asset, you
-- cannot resolve its tags.
create policy asset_identifiers_select on asset_identifiers for select
  using (asset_id in (select id from assets));

create policy asset_identifiers_write on asset_identifiers for all
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = 'admin'
      or (current_user_role() = 'facility_manager'
          and asset_id in (select id from assets
                           where property_id in (select current_user_property_ids())))
    )
  )
  with check (
    org_id = current_user_org_id()
    and (
      current_user_role() = 'admin'
      or (current_user_role() = 'facility_manager'
          and asset_id in (select id from assets
                           where property_id in (select current_user_property_ids())))
    )
  );

create trigger audit_asset_identifier_write
  after insert or update or delete on asset_identifiers
  for each row execute function log_audit('asset_identifier.write');

-- Scan resolver for the Phase-2 PWA: symbology-agnostic by design — the caller
-- passes whatever the scanner read and gets the asset back, or nothing.
-- SECURITY DEFINER so the lookup is a single indexed hit, but it re-applies the
-- same org + property scoping as assets_select, so it cannot widen visibility.
create or replace function find_asset_by_identifier(p_value text)
returns setof assets language sql security definer stable set search_path = public as $$
  select a.*
  from assets a
  join asset_identifiers i on i.asset_id = a.id
  where lower(i.value) = lower(trim(p_value))
    and a.deleted_at is null
    and a.org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or a.property_id in (select current_user_property_ids())
    );
$$;

revoke all on function find_asset_by_identifier(text) from public;
grant execute on function find_asset_by_identifier(text) to authenticated;

-- The single-value column is superseded. Nothing has been written to it yet
-- (the register was created in this same phase), so dropping it is clean.
alter table assets drop column if exists qr_code;
