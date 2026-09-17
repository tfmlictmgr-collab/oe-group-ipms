-- Asset register, part 2: compliance, insurance, and admin-definable fields.
--
-- Three additions, all OPTIONAL — nothing here becomes a required entry, so a
-- quick register of tag/name/category stays valid:
--
--   1. Insurance + statutory-compliance columns on assets. These are first-class
--      (not JSONB) because they drive expiry alerting and reporting, which needs
--      indexes and date maths.
--   2. asset_certificates — an asset typically holds SEVERAL documents
--      (electrical test, fire cert, LOLER, insurance schedule, warranty), each
--      with its own issuer and expiry. One row per document.
--   3. Admin-definable custom fields — org admins/FMs can append fields with no
--      code and no migration, stored in assets.custom_fields (JSONB). Same
--      hybrid pattern as tenant applications: typed columns for what we query,
--      JSONB for what varies by client.

-- ── 1. Insurance + compliance (all nullable) ───────────────────────────────
alter table assets add column if not exists insurer_name        text;
alter table assets add column if not exists insurance_policy_no text;
alter table assets add column if not exists insured_value       numeric(14,2)
  check (insured_value is null or insured_value >= 0);
alter table assets add column if not exists insurance_expiry    date;

-- Statutory / regulatory inspection regime (e.g. fire equipment servicing,
-- lift LOLER inspection, electrical periodic testing, generator emissions).
alter table assets add column if not exists compliance_required   boolean not null default false;
alter table assets add column if not exists regulatory_standard   text;   -- e.g. 'NFPA 10', 'SON', 'LOLER'
alter table assets add column if not exists certifying_body       text;   -- who issues/inspects
alter table assets add column if not exists certificate_number    text;
alter table assets add column if not exists certificate_expiry    date;
alter table assets add column if not exists last_inspection_date  date;
alter table assets add column if not exists next_inspection_due   date;

-- Expiry dashboards: "what lapses in the next 30/60/90 days" must stay fast at
-- 100+ properties, so index the dates we alert on (active assets only).
create index if not exists assets_insurance_expiry_idx on assets (org_id, insurance_expiry)
  where deleted_at is null and insurance_expiry is not null;
create index if not exists assets_cert_expiry_idx on assets (org_id, certificate_expiry)
  where deleted_at is null and certificate_expiry is not null;
create index if not exists assets_next_inspection_idx on assets (org_id, next_inspection_due)
  where deleted_at is null and next_inspection_due is not null;

-- ── 2. Certificates / documents held against an asset ──────────────────────
create type asset_certificate_kind as enum (
  'insurance',
  'statutory_inspection',   -- e.g. lift, pressure vessel
  'electrical_test',
  'fire_safety',
  'calibration',
  'warranty',
  'service_contract',
  'installation',
  'environmental',
  'other'
);

create table asset_certificates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  kind asset_certificate_kind not null default 'other',
  reference text,               -- certificate / policy number
  issuer text,                  -- certifying body or insurer
  issued_date date,
  expiry_date date,
  document_url text,            -- scan/PDF (Storage), optional
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index asset_certificates_asset_idx  on asset_certificates (asset_id);
create index asset_certificates_org_idx    on asset_certificates (org_id);
create index asset_certificates_expiry_idx on asset_certificates (org_id, expiry_date)
  where expiry_date is not null;

alter table asset_certificates enable row level security;

-- A certificate inherits the access rules of the asset it belongs to: if you
-- cannot see the asset, you cannot see its documents.
create policy asset_certificates_select on asset_certificates for select
  using (asset_id in (select id from assets));

create policy asset_certificates_write on asset_certificates for all
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

create trigger audit_asset_certificate_write
  after insert or update or delete on asset_certificates
  for each row execute function log_audit('asset_certificate.write');

-- ── 3. Admin-definable custom fields (append fields with no code) ──────────
create type asset_field_type as enum ('text', 'number', 'date', 'boolean', 'select');

create table asset_field_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  field_key text not null,             -- stable machine key, e.g. 'refrigerant_type'
  label text not null,                 -- what the FM/PM sees
  field_type asset_field_type not null default 'text',
  options text[],                      -- for 'select'
  help_text text,
  required boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One definition per key per org; keys are lower_snake_case.
create unique index asset_field_definitions_org_key_uidx
  on asset_field_definitions (org_id, lower(field_key));
create index asset_field_definitions_org_idx on asset_field_definitions (org_id);

alter table asset_field_definitions enable row level security;

-- Everyone in the org may READ the definitions (needed to render/label values);
-- only an admin may change the shape of the register.
create policy asset_field_definitions_select on asset_field_definitions for select
  using (org_id = current_user_org_id());

create policy asset_field_definitions_write on asset_field_definitions for all
  using (org_id = current_user_org_id() and current_user_role() = 'admin')
  with check (org_id = current_user_org_id() and current_user_role() = 'admin');

create trigger audit_asset_field_definition_write
  after insert or update or delete on asset_field_definitions
  for each row execute function log_audit('asset_field_definition.write');

-- Values for those definitions. JSONB keyed by field_key, so adding a field is
-- a data change, never a migration.
alter table assets add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- Guard against a non-object (e.g. an array or scalar) being written.
alter table assets drop constraint if exists assets_custom_fields_is_object;
alter table assets add constraint assets_custom_fields_is_object
  check (jsonb_typeof(custom_fields) = 'object');

create index if not exists assets_custom_fields_gin on assets using gin (custom_fields);
