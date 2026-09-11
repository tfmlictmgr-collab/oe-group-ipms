-- A unit row can stand for more than one unit, and says what it is.
--
-- The units panel asked for three things and conflated two of them:
--
--     Label     free text — "Flat 2", "Suite 101"
--     Factor    a bare number with no unit of measure printed anywhere
--     Occupant  a person
--
-- `Factor` is floor area in square metres — that is what apportionment has
-- always divided by — but nothing on the screen said so, so it was typed as
-- 85.5 by someone who knew and as 2 by someone who thought it meant "how many".
-- The column is renamed in the UI to **Occupied Space** and prints m²; the
-- COLUMN and every existing value are untouched, because the number was never
-- wrong, only unlabelled.
--
-- ── What is genuinely new ─────────────────────────────────────────────────
-- A commercial property is not let one row at a time. Twelve stalls at 20 m²
-- are one commercial arrangement, and filing them as twelve near-identical
-- rows is how a register stops being maintained. `unit_quantity` lets one row
-- stand for many.
--
-- ⚠️ **It is not decoration — it changes the bill.** Occupied Space is PER
-- unit, so this row's contribution to its property's total is
-- `apportionment_factor * unit_quantity`. A row of 12 stalls at 20 m²
-- contributes 240 m², not 20. Recording the quantity while apportioning the
-- single-unit area would hand eleven stalls a free ride and quietly
-- redistribute their share across their neighbours — the exact harm
-- `units_apportionment_positive` (0056) was added to prevent, arrived at from
-- a new direction.
--
-- ── Why `unit_quantity` and not `unit_count` ──────────────────────────────
-- `property_summary` already publishes a column called `unit_count` meaning
-- "how many unit ROWS this property has". Two different quantities under one
-- name, one of them feeding a bill, is a defect waiting for its afternoon.
--
-- ── What deliberately does NOT change ─────────────────────────────────────
-- `property_windows.vacant_count` (0076/0077) still counts ROWS with no
-- occupant, and stays that way. Decision 11 asks it one boolean question —
-- "open iff a vacant unit exists" — and a row of 12 vacant stalls answers it
-- identically whether counted as 1 or 12. Rewriting it would risk opening or
-- closing a property's application window for no gain.

-- ── 1. The two new columns ────────────────────────────────────────────────
alter table units add column if not exists unit_quantity integer not null default 1;
alter table units add column if not exists description text;

alter table units drop constraint if exists units_quantity_positive;
alter table units add constraint units_quantity_positive
  check (unit_quantity > 0);

comment on column units.unit_quantity is
  'How many physical units this row stands for — 12 stalls, 4 parking bays. Default 1, which is every row written before 0198 and every ordinary single flat. Multiplies apportionment_factor when the service charge is apportioned: the area is PER unit.';

comment on column units.description is
  'Freeform note — "Block A, ground floor", "sublet to a sister company". Informational only: nothing computes from it. It does, however, distinguish two rows sharing a type (see units_property_label_desc_uidx below).';

comment on column units.apportionment_factor is
  'Occupied space in SQUARE METRES, per unit. Unlabelled on screen until 0198, which is how it came to be typed as a count by some and an area by others. Multiplied by unit_quantity to reach the row''s share of a service-charge budget.';

-- ── 2. The label becomes a chosen type, so it needs a catalogue ───────────
-- Free text produced "Flat 2", "flat 2", "Flat2" and "F2" as four units in one
-- building — 0186's lesson about locations, in a second place: an offered list
-- is what stops the spellings, and the spellings are what a sibling-name
-- constraint cannot catch, because they are genuinely different strings.
--
-- ⚠️ Unlike 0186's `nigeria_states`, this set is NOT closed. Nigerian property
-- has arrangements no seeded list will hold, so an org may add its own — the
-- "somewhere else…" affordance 0186 kept, for the same reason.
create table if not exists unit_types (
  id uuid primary key default gen_random_uuid(),
  -- NULL means a platform standard, offered to every organisation. A non-null
  -- org_id is one org's own addition, visible to nobody else — B1 applies to a
  -- dropdown's contents as much as to a data row.
  org_id uuid references orgs(id),
  label text not null,
  category text not null check (category in ('residential', 'commercial')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists unit_types_org_id_idx on unit_types(org_id);

create unique index if not exists unit_types_standard_label_uidx
  on unit_types (lower(label)) where org_id is null and deleted_at is null;
create unique index if not exists unit_types_org_label_uidx
  on unit_types (org_id, lower(label)) where org_id is not null and deleted_at is null;

alter table unit_types enable row level security;

drop policy if exists unit_types_select on unit_types;
create policy unit_types_select on unit_types for select
  using (deleted_at is null and (org_id is null or org_id = current_user_org_id()));

-- Adding a type is part of filing a property, so it rides on the capability
-- that already governs that (0191's reasoning: deciding what is attached to a
-- building is the same authority as editing the building's record). It is NOT
-- gated on hierarchy.write — adding "Kiosk" is not a structural act.
drop policy if exists unit_types_insert on unit_types;
create policy unit_types_insert on unit_types for insert
  with check (
    org_id = current_user_org_id()
    and has_permission('properties.write')
  );

drop policy if exists unit_types_update on unit_types;
create policy unit_types_update on unit_types for update
  using (org_id = current_user_org_id() and has_permission('properties.write'))
  with check (org_id = current_user_org_id() and has_permission('properties.write'));

comment on table unit_types is
  'The descriptions offered when filing a unit, grouped residential/commercial. org_id NULL is a platform standard offered to everyone; a non-null org_id is that org''s own addition and is visible to no other org. Added by 0198 — free text had produced four spellings of one flat.';

-- ── 3. The standard set ───────────────────────────────────────────────────
-- Nigerian residential and commercial stock as it is actually let. Seeded
-- org-agnostic so a new organisation is useful on its first day.
insert into unit_types (org_id, label, category)
select null, t.label, t.category from (values
  ('Bungalow',            'residential'),
  ('Detached House',      'residential'),
  ('Semi-detached House', 'residential'),
  ('Terrace',             'residential'),
  ('Duplex',              'residential'),
  ('Maisonette',          'residential'),
  ('Flat / Apartment',    'residential'),
  ('Self-contained',      'residential'),
  ('Studio',              'residential'),
  ('Penthouse',           'residential'),
  ('Boys Quarters',       'residential'),
  ('Office Complex',      'commercial'),
  ('Office Suite',        'commercial'),
  ('Open-plan Office',    'commercial'),
  ('Shop',                'commercial'),
  ('Stall',               'commercial'),
  ('Mall Unit',           'commercial'),
  ('Kiosk',               'commercial'),
  ('Showroom',            'commercial'),
  ('Warehouse',           'commercial'),
  ('Cold Room',           'commercial'),
  ('Restaurant Space',    'commercial'),
  ('Event Hall',          'commercial'),
  ('Open Space',          'commercial'),
  ('Parking Bay',         'commercial'),
  ('Filling Station',     'commercial'),
  ('Industrial Unit',     'commercial')
) as t(label, category)
where not exists (
  select 1 from unit_types x
   where x.org_id is null and lower(x.label) = lower(t.label)
);

-- ── 4. The uniqueness rule has to move with the meaning ───────────────────
-- 0056 made (property_id, lower(label)) unique because "Flat 2 twice makes
-- every per-unit invoice ambiguous and silently doubles that property's share".
-- The reasoning is still right; the KEY is not. Once the label is a type,
-- that index forbids a building from having two terraces — which is most
-- buildings.
--
-- ⚠️ The protection is kept, not dropped. `description` joins the key, so two
-- rows genuinely describing different things ("Terrace — Block A", "Terrace —
-- Block B") both stand, while an accidental duplicate of an identical row is
-- still refused. That is what makes the freeform column load-bearing enough to
-- be worth having.
drop index if exists units_property_label_uidx;
create unique index if not exists units_property_label_desc_uidx
  on units (property_id, lower(label), lower(coalesce(description, '')))
  where deleted_at is null;

comment on index units_property_label_desc_uidx is
  'Replaces units_property_label_uidx (0056). The label became a chosen type in 0198, so uniqueness on it alone forbade a building having two terraces. Description joins the key: two distinguishable rows stand, an identical duplicate is still refused — and a duplicate is what silently doubles a property''s share of a budget.';

-- ── 5. The property summary has to count the quantity ─────────────────────
-- ⚠️ THIS is the half that would otherwise diverge. `total_factor` is what the
-- properties list prints and what a reader checks an apportionment against. Had
-- only the TypeScript learned about quantity, the screen and the bill would
-- disagree, and the screen is what someone would trust.
--
-- Rebuilt from 0084's definition — the live one — with two changes and nothing
-- else touched: total_factor multiplies by quantity, and unit_total is added
-- beside the existing unit_count rather than replacing it.
--
-- `unit_count` KEEPS its meaning (how many rows). Every existing consumer —
-- PropertyStats' occupancy ratio, the properties list, PropertyWindows —
-- reads it, and quietly changing what a published column means is how a
-- dashboard starts lying without a single error.
drop view if exists property_summary;
create view property_summary as
  select
    p.id,
    p.org_id,
    p.name,
    p.reference,
    p.address,
    p.property_type,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null)              as unit_count,
    (select coalesce(sum(u.unit_quantity), 0) from units u
      where u.property_id = p.id and u.deleted_at is null)              as unit_total,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null
        and u.occupant_user_id is not null)                             as occupied_count,
    (select coalesce(sum(u.apportionment_factor * u.unit_quantity), 0) from units u
      where u.property_id = p.id and u.deleted_at is null)              as total_factor,
    (select count(*) from assets a
      where a.property_id = p.id and a.deleted_at is null)              as asset_count,
    p.site_node_id,
    case when p.site_node_id is not null then node_full_name(p.site_node_id) end as node_path
  from properties p
 where p.deleted_at is null;

comment on view property_summary is
  'Per-property rollup. unit_count is how many unit ROWS exist; unit_total is how many physical units they stand for (0198 — one row can be 12 stalls); total_factor is occupied space x quantity, which is exactly what the service-charge apportionment divides by.';

-- ── 6. Prove it, rather than reporting success ────────────────────────────
do $$
declare
  v_total numeric;
  v_view  numeric;
  v_standards int;
begin
  select count(*) into v_standards from unit_types where org_id is null and deleted_at is null;
  if v_standards < 20 then
    raise exception 'unit_types seeded only % standard rows', v_standards;
  end if;

  -- The multiplication actually reaches the view. Asserted against real rows
  -- rather than trusted: a view compiles happily with the wrong arithmetic.
  select coalesce(sum(u.apportionment_factor * u.unit_quantity), 0)
    into v_total from units u where u.deleted_at is null;
  select coalesce(sum(total_factor), 0) into v_view from property_summary;

  if v_total is distinct from v_view then
    raise exception
      'property_summary.total_factor (%) does not equal sum(factor * quantity) (%)',
      v_view, v_total;
  end if;

  if exists (select 1 from units where unit_quantity is null or unit_quantity < 1) then
    raise exception 'a unit row carries a non-positive quantity';
  end if;
end;
$$;
