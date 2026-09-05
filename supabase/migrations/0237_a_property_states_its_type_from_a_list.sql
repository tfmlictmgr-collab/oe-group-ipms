-- A property states its type from a list, grouped the way the board asked.
--
-- `properties.property_type` is free text and has been since 0003. The Add
-- Property form offered an input with the placeholder "e.g. Residential estate,
-- Office tower", which is a hint and not a set — so the register accumulates
-- "Office Complex", "office complex", "Office cplx" and "Offices" as four
-- descriptions of one kind of building, and no report can group by it.
--
-- 📌 This is `0198`'s lesson about unit labels and `0186`'s about locations,
-- in a third place, and the fix is deliberately the SAME fix rather than a new
-- one: an offered list is what stops the spellings, because a sibling-name
-- constraint cannot catch them — they are genuinely different strings.
--
-- ── Mirrors unit_types exactly, and does not reuse it ─────────────────────
--
-- The shape below is `0198`'s `unit_types` line for line: a nullable `org_id`
-- where NULL is a platform standard and a value is one org's own addition
-- (B1 applies to a dropdown's contents as much as to a data row), a
-- residential/commercial check, soft delete, and the two partial unique
-- indexes that keep standard labels unique globally and org labels unique per
-- org.
--
-- ⚠️ It is a SEPARATE table, and reusing `unit_types` would have been wrong.
-- A property is an "Office Complex"; a unit inside it is an "Office Suite" or
-- a "Kiosk". The two vocabularies overlap in places and are not the same set,
-- and merging them would offer "Boys Quarters" as a description of an estate
-- and "Shopping Mall" as a description of a flat. One table per question.
--
-- ── The type stays TEXT on the property ──────────────────────────────────
--
-- No foreign key, and no column change at all. `0198` did the same for units:
-- the catalogue supplies the label, the row stores the label. Three reasons,
-- and the third is the one that matters:
--   • five readers already select `property_type` as a string and render it
--   • an org that retires a description does not thereby rewrite the history
--     of every property filed under it
--   • every property already carrying free text KEEPS it. There are live rows
--     typed by hand, and a migration that pointed this column at a catalogue
--     would have to either discard them or invent a catalogue row per spelling.
--     The form preserves an unrecognised value as its own option instead, so
--     editing a property filed before this migration cannot silently blank
--     what somebody recorded.

create table if not exists property_types (
  id uuid primary key default gen_random_uuid(),
  -- NULL means a platform standard, offered to every organisation. A non-null
  -- org_id is one org's own addition, visible to nobody else.
  org_id uuid references orgs(id),
  label text not null,
  category text not null check (category in ('residential', 'commercial')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists property_types_org_id_idx on property_types(org_id);

create unique index if not exists property_types_standard_label_uidx
  on property_types (lower(label)) where org_id is null and deleted_at is null;
create unique index if not exists property_types_org_label_uidx
  on property_types (org_id, lower(label)) where org_id is not null and deleted_at is null;

alter table property_types enable row level security;

drop policy if exists property_types_select on property_types;
create policy property_types_select on property_types for select
  using (deleted_at is null and (org_id is null or org_id = current_user_org_id()));

-- Adding a type is part of filing a property, so it rides on the capability
-- that already governs that — `0198`'s reasoning, unchanged. NOT gated on
-- `hierarchy.write`: naming a kind of building is not a structural act.
drop policy if exists property_types_insert on property_types;
create policy property_types_insert on property_types for insert
  with check (
    org_id = current_user_org_id()
    and has_permission('properties.write')
  );

drop policy if exists property_types_update on property_types;
create policy property_types_update on property_types for update
  using (org_id = current_user_org_id() and has_permission('properties.write'))
  with check (org_id = current_user_org_id() and has_permission('properties.write'));

comment on table property_types is
  'The descriptions offered when filing a PROPERTY, grouped residential/commercial. Mirrors unit_types (0198) and is deliberately separate from it: a property is an Office Complex, a unit inside it is an Office Suite. org_id NULL is a platform standard; a non-null org_id is that org''s own addition, visible to no other org. properties.property_type remains free text -- the catalogue supplies the label, the row stores it, and rows filed before 0237 keep what they carry.';

-- ── The standard set ──────────────────────────────────────────────────────
--
-- Nigerian stock as it is actually held and let. Seeded org-agnostic so a new
-- organisation is useful on its first day.
--
-- ⚠️ Mixed-use sits under `commercial`, and that is a filing decision rather
-- than a claim about the building. The category exists to halve a dropdown, not
-- to classify tenure: a mixed-use development is bought, managed and reported
-- as a commercial asset here even where most of its floors are flats. An org
-- that disagrees adds its own description on the residential side; the table
-- is not closed, which is the whole point of the nullable org_id above.
insert into property_types (org_id, label, category)
select null, t.label, t.category from (values
  -- Residential
  ('Residential Estate',        'residential'),
  ('Block of Flats',            'residential'),
  ('Apartment Building',        'residential'),
  ('Detached House',            'residential'),
  ('Semi-detached House',       'residential'),
  ('Terrace Row',               'residential'),
  ('Duplex',                    'residential'),
  ('Bungalow',                  'residential'),
  ('Serviced Apartments',       'residential'),
  ('Student Housing',           'residential'),
  ('Staff Quarters',            'residential'),
  -- Commercial
  ('Office Complex',            'commercial'),
  ('Office Tower',              'commercial'),
  ('Business Park',             'commercial'),
  ('Shopping Mall',             'commercial'),
  ('Shopping Plaza',            'commercial'),
  ('Retail Shops',              'commercial'),
  ('Market',                    'commercial'),
  ('Warehouse',                 'commercial'),
  ('Industrial Estate',         'commercial'),
  ('Factory',                   'commercial'),
  ('Hotel',                     'commercial'),
  ('Event Centre',              'commercial'),
  ('Filling Station',           'commercial'),
  ('Cold Store',                'commercial'),
  ('School',                    'commercial'),
  ('Hospital / Clinic',         'commercial'),
  ('Place of Worship',          'commercial'),
  ('Mixed-use Development',     'commercial')
) as t(label, category)
where not exists (
  select 1 from property_types p
   where p.org_id is null and lower(p.label) = lower(t.label)
);

-- `authenticated` reads and writes through the policies above; nothing here is
-- callable by `anon`, which is the revoke this repo has now forgotten four
-- times (0204, 0209, 0210, 0231). A table, not a function — so the guard is the
-- grant itself.
revoke all on table property_types from anon;
grant select, insert, update on table property_types to authenticated;
