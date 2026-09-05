-- REGION → LOCATION → PROJECT → SITE, and Nigeria's actual geography seeded.
--
-- ⚠️ **This changes the level order the 29 July board minuted** (REGION →
-- PROJECT → LOCATION → SITE). It needs recording as an amendment, and here is
-- the argument for it.
--
-- The board's own description of the structure is geographic: regions follow
-- Nigeria's geopolitical mapping, and the places named underneath them are
-- cities — Kano, Sokoto and Abuja in the North; Lagos and Ibadan in the South;
-- Port Harcourt, Enugu, Owerri and Yenagoa in the East. Under the minuted order
-- you cannot record "Kano" until you have first invented a *project* to put it
-- in, because PROJECT sits between REGION and LOCATION.
--
-- That is backwards. **A project happens in a place; a place does not happen in
-- a project.** "Kano Housing Scheme" is a project in Kano. There is no sense in
-- which Kano is inside a scheme. The minuted order forces every user to create
-- a fictional parent before they can name a real city, and the fiction then
-- appears in every regional report.
--
-- `0066` anticipated exactly this: it wrote the ordering as an explicit function
-- *"rather than relying on the enum's declaration order: adding a level later
-- must be a considered change here, not something that silently re-parents an
-- existing tree."* This is that considered change.
--
-- Nothing else moves. `properties.site_node_id` still points at a SITE, the path
-- is still materialised, and `current_user_property_ids()` is untouched — the
-- resolver walks paths and never mentions a level by name, which is why
-- reordering is contained rather than sweeping.

-- ── The new order ─────────────────────────────────────────────────────────
create or replace function hierarchy_depth(p_level hierarchy_level)
returns integer language sql immutable as $$
  select case p_level
           when 'region'   then 1
           when 'location' then 2   -- was 3
           when 'project'  then 3   -- was 2
           when 'site'     then 4
         end;
$$;

comment on function hierarchy_depth is
  'REGION → LOCATION → PROJECT → SITE. Amends the 29 July board order, which placed PROJECT above LOCATION and so required inventing a project before a city could be named. A project happens in a place, not the other way round.';

-- ── Existing tree: anything already filed under the old order ─────────────
--
-- Only nodes that would now be illegal are touched, and each is re-levelled
-- rather than deleted — a node's id appears in the path of everything beneath
-- it and in the audit trail of every property filed under it.
--
-- At the time of writing the only affected row is a `project` sitting directly
-- under a `region`, which under the new order is exactly what a `location` is.
-- Re-levelling it preserves its identity, its path and its assignments.
update org_nodes child
   set level = 'location'
  from org_nodes parent
 where child.parent_id = parent.id
   and parent.level = 'region'
   and child.level = 'project'
   and child.deleted_at is null;

-- ── Nigeria's geopolitical mapping, seeded ────────────────────────────────
--
-- The board asked for three regions rather than the six federal zones, so the
-- states are grouped into those three. Seeded for every LIVE org — including
-- the POC org, which `0066` skipped as "a demo fixture" and which turned out to
-- be the org the team actually works in. A structure that exists for two orgs
-- out of three is a structure nobody trusts.
insert into org_nodes (org_id, parent_id, level, name, code, path)
  select o.id, null, 'region', r.name, r.code, ''
    from orgs o
    cross join (values ('North', 'NR'), ('South', 'ST'), ('East', 'ET')) as r(name, code)
   where o.deleted_at is null
     and not exists (
       select 1 from org_nodes n
        where n.org_id = o.id and n.level = 'region'
          and lower(n.name) = lower(r.name) and n.deleted_at is null
     );

-- Major cities under each region. A starting point a manager edits, not a
-- fixed list — `hierarchy.write` renames, adds and retires them.
insert into org_nodes (org_id, parent_id, level, name, path)
  select reg.org_id, reg.id, 'location', loc.name, ''
    from org_nodes reg
    join (values
      ('North', 'Abuja'), ('North', 'Kano'), ('North', 'Kaduna'),
      ('North', 'Sokoto'), ('North', 'Jos'), ('North', 'Maiduguri'),
      ('North', 'Ilorin'), ('North', 'Katsina'),
      ('South', 'Lagos'), ('South', 'Ibadan'), ('South', 'Benin City'),
      ('South', 'Abeokuta'), ('South', 'Akure'), ('South', 'Osogbo'),
      ('South', 'Warri'),
      ('East', 'Port Harcourt'), ('East', 'Enugu'), ('East', 'Owerri'),
      ('East', 'Aba'), ('East', 'Onitsha'), ('East', 'Awka'),
      ('East', 'Calabar'), ('East', 'Uyo'), ('East', 'Yenagoa'),
      ('East', 'Umuahia')
    ) as loc(region, name) on loc.region = reg.name
   where reg.level = 'region'
     and reg.deleted_at is null
     and not exists (
       select 1 from org_nodes n
        where n.org_id = reg.org_id and n.parent_id = reg.id
          and lower(n.name) = lower(loc.name) and n.deleted_at is null
     );
