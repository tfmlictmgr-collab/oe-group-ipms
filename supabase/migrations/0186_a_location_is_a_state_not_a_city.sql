-- Locations are Nigeria's STATES, chosen from a list, not cities typed by hand.
-- (Board direction, 21 Aug 2026 — refines decision 8's seeding.)
--
-- 0087 seeded twenty-five major CITIES as locations under the three regions,
-- and 0097 made that something every org gets. Cities were a reasonable reading
-- of "regions follow Nigeria's geopolitical mapping" and they are the wrong
-- unit in practice, for two reasons that only show up once people file real
-- work:
--
--   * **A city is not a jurisdiction.** The portfolio is administered against
--     states — that is how Nigerian property is titled, how tenancy law
--     applies, and how a regional report is read by anyone at the board table.
--     "Warri" and "Benin City" are two rows that both mean business in Delta
--     and Edo respectively, and neither is the unit anyone reports on.
--   * **Twenty-five cities is a sample, not a set.** A manager in Gombe,
--     Ebonyi or Zamfara found no row for their place and had to invent one,
--     which is precisely the "dead end for the first property in a new city"
--     that decision 8 added `hierarchy.write` to avoid. A free-text field then
--     produces "Portharcourt", "Port-Harcourt" and "PH" as three locations,
--     and `org_nodes_sibling_name_uidx` cannot help because they are genuinely
--     different strings.
--
-- 36 states and the FCT is a CLOSED set. That is what makes it offerable as a
-- dropdown, and a dropdown is what stops the three spellings.
--
-- ── The three-region mapping ──────────────────────────────────────────────
--
-- The board asked for three regions rather than the six federal zones, so each
-- state is assigned to one of them. The assignment is not invented here — it is
-- read off the city seed 0087 already used, so nothing moves region:
--
--     0087 put Benin City and Warri in SOUTH  → Edo and Delta are South
--     0087 put Calabar, Uyo, Yenagoa, PH in EAST → Cross River, Akwa Ibom,
--                                                  Bayelsa, Rivers are East
--
-- So: North = the 19 northern states + FCT · South = the 6 South-West states +
-- Edo + Delta · East = the 5 South-East states + the remaining 4 South-South.
-- 20 + 8 + 9 = 37.

-- ── The reference list ────────────────────────────────────────────────────
--
-- A TABLE rather than a constant in a function, because the dropdown needs to
-- read it and the seed needs to read it, and those two must not be able to
-- disagree about what a state is. Reference data with no org_id: it describes
-- Nigeria, not a customer.
create table if not exists nigeria_states (
  code   text primary key,
  name   text not null unique,
  region text not null check (region in ('North', 'South', 'East'))
);

comment on table nigeria_states is
  'Nigeria''s 36 states and the FCT, each assigned to one of the board''s three regions. Reference data, not tenant data — no org_id, identical for every organisation. One source for both the location dropdown and seed_org_hierarchy, so the offered list and the seeded list cannot drift apart. `code` is ISO 3166-2:NG.';

insert into nigeria_states (code, name, region) values
  -- North: the 19 northern states and the Federal Capital Territory.
  ('FC', 'Federal Capital Territory', 'North'),
  ('AD', 'Adamawa', 'North'), ('BA', 'Bauchi', 'North'),
  ('BE', 'Benue', 'North'),   ('BO', 'Borno', 'North'),
  ('GO', 'Gombe', 'North'),   ('JI', 'Jigawa', 'North'),
  ('KD', 'Kaduna', 'North'),  ('KN', 'Kano', 'North'),
  ('KT', 'Katsina', 'North'), ('KE', 'Kebbi', 'North'),
  ('KO', 'Kogi', 'North'),    ('KW', 'Kwara', 'North'),
  ('NA', 'Nasarawa', 'North'),('NI', 'Niger', 'North'),
  ('PL', 'Plateau', 'North'), ('SO', 'Sokoto', 'North'),
  ('TA', 'Taraba', 'North'),  ('YO', 'Yobe', 'North'),
  ('ZA', 'Zamfara', 'North'),
  -- South: the South-West six, plus Edo and Delta — where 0087 put Benin City
  -- and Warri.
  ('EK', 'Ekiti', 'South'),   ('LA', 'Lagos', 'South'),
  ('OG', 'Ogun', 'South'),    ('ON', 'Ondo', 'South'),
  ('OS', 'Osun', 'South'),    ('OY', 'Oyo', 'South'),
  ('ED', 'Edo', 'South'),     ('DE', 'Delta', 'South'),
  -- East: the South-East five, plus the four South-South states 0087 placed
  -- East via Calabar, Uyo, Yenagoa and Port Harcourt.
  ('AB', 'Abia', 'East'),     ('AN', 'Anambra', 'East'),
  ('EB', 'Ebonyi', 'East'),   ('EN', 'Enugu', 'East'),
  ('IM', 'Imo', 'East'),      ('AK', 'Akwa Ibom', 'East'),
  ('BY', 'Bayelsa', 'East'),  ('CR', 'Cross River', 'East'),
  ('RI', 'Rivers', 'East')
on conflict (code) do nothing;

alter table nigeria_states enable row level security;

-- Readable by anyone signed in, and by nobody else. A state list reveals
-- nothing about any organisation — B1's "or existence" concerns the client
-- list, not the map of Nigeria — but it is still not anonymous, because an
-- unauthenticated caller has no reason to enumerate anything.
drop policy if exists nigeria_states_select on nigeria_states;
create policy nigeria_states_select on nigeria_states for select to authenticated
  using (true);

revoke all on nigeria_states from anon, authenticated;
grant select on nigeria_states to authenticated;

-- ── Seeding reads the list ────────────────────────────────────────────────
--
-- Rewritten from 0097, which is the live definition. The regions half is
-- carried across verbatim; only the locations half changes, from twenty-five
-- literal city names to a join against `nigeria_states`.
create or replace function seed_org_hierarchy(p_org_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_before integer;
  v_after  integer;
begin
  if p_org_id is null then
    raise exception 'seed_org_hierarchy needs an organisation';
  end if;

  -- The operator holds no client data (0088). A region filed against the control
  -- plane is exactly the "just one row" that erodes that separation.
  if exists (select 1 from orgs where id = p_org_id and is_platform_operator) then
    return 0;
  end if;

  select count(*) into v_before from org_nodes where org_id = p_org_id;

  -- Three regions, per the board's mapping rather than the six federal zones.
  insert into org_nodes (org_id, parent_id, level, name, code, path)
    select p_org_id, null, 'region', r.name, r.code, ''
      from (values ('North', 'NR'), ('South', 'ST'), ('East', 'ET')) as r(name, code)
     where not exists (
       select 1 from org_nodes n
        where n.org_id = p_org_id and n.level = 'region'
          and lower(n.name) = lower(r.name) and n.deleted_at is null
     );

  -- States as LOCATIONS directly under their region — the v3.4 order (0087),
  -- the v3.5 unit (this migration).
  insert into org_nodes (org_id, parent_id, level, name, code, path)
    select reg.org_id, reg.id, 'location', s.name,
           -- The ISO code, unless this org already spent it on a node of its
           -- own. A collision must cost the state its code, never its row —
           -- a missing state is the dead end this migration exists to remove.
           case when exists (
                  select 1 from org_nodes x
                   where x.org_id = reg.org_id and x.code = s.code
                     and x.deleted_at is null
                ) then null else s.code end,
           ''
      from org_nodes reg
      join nigeria_states s on s.region = reg.name
     where reg.org_id = p_org_id
       and reg.level = 'region'
       and reg.deleted_at is null
       and not exists (
         select 1 from org_nodes n
          where n.org_id = reg.org_id and n.parent_id = reg.id
            and lower(n.name) = lower(s.name) and n.deleted_at is null
       );

  select count(*) into v_after from org_nodes where org_id = p_org_id;
  return v_after - v_before;
end;
$$;

comment on function seed_org_hierarchy is
  'Seeds the three regions and Nigeria''s 36 states + FCT as locations for one org, in the v3.4 REGION → LOCATION → PROJECT → SITE order. Reads nigeria_states so the seeded set and the dropdown cannot diverge. Idempotent: fills gaps, never duplicates, returns how many nodes it added.';

-- ── Every existing org gets the states ────────────────────────────────────
do $$
declare o record; n integer;
begin
  for o in select id, name from orgs
            where deleted_at is null and not is_platform_operator loop
    n := seed_org_hierarchy(o.id);
    if n > 0 then raise notice 'seeded % state location(s) for %', n, o.name; end if;
  end loop;
end $$;

-- ── The untouched city seed is retired ────────────────────────────────────
--
-- ⚠️ Strictly the ones NOBODY HAS USED. A city location with a project under
-- it, a property beneath it, or a manager assigned to it is somebody's real
-- filing decision, and this migration has no business overruling it — the tree
-- is explicitly "a starting point a manager edits, not a fixed list" (0087).
-- Those stay exactly where they are, as siblings of the states, and a manager
-- can move or retire them when it suits them.
--
-- 📌 Retired, not deleted. A node's id appears in the materialised path of
-- everything beneath it and in the audit trail of every property ever filed
-- under it (0087's own reasoning for re-levelling rather than deleting).
--
-- On the four live worlds this leaves TFML/Aba, TFML/Abuja, SC-Client/Lagos and
-- POC/Aba standing, and retires the rest of the untouched seed.
with untouched as (
  select n.id, n.org_id, n.name
    from org_nodes n
   where n.level = 'location'
     and n.deleted_at is null
     -- Only names the CITY seed introduced, and only where that name is not
     -- itself a state — Kano, Kaduna, Sokoto, Katsina, Enugu and Lagos were
     -- seeded as cities and are states, so the state insert above matched them
     -- by name and they were never duplicated. Retiring them would delete the
     -- state.
     and n.name in ('Abuja', 'Jos', 'Maiduguri', 'Ilorin',
                    'Ibadan', 'Benin City', 'Abeokuta', 'Akure', 'Osogbo', 'Warri',
                    'Port Harcourt', 'Owerri', 'Aba', 'Onitsha', 'Awka',
                    'Calabar', 'Uyo', 'Yenagoa', 'Umuahia')
     and not exists (select 1 from org_nodes ch
                      where ch.parent_id = n.id and ch.deleted_at is null)
     and not exists (select 1 from properties p
                      where p.site_node_id = n.id and p.deleted_at is null)
     and not exists (select 1 from property_stakeholders ps where ps.node_id = n.id)
)
update org_nodes t
   set deleted_at = now()
  from untouched u
 where t.id = u.id;
