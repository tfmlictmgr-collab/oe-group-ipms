-- REGION → PROJECT → LOCATION → SITE, above the property register.
--
-- Board recommendation, 29 July 2026. Both TFML and OEA organise their portfolios
-- geographically: regions follow Nigeria's geopolitical mapping, each region runs
-- projects, projects sit in locations, locations contain sites, and a site holds
-- the properties already in the register.
--
-- ONE table, not five. `current_user_property_ids()` is referenced 42 times across
-- 13 migrations — the property is the security anchor for tickets, assets,
-- service-charge budgets, tenant applications and the attaché assignment. Five
-- nested tables would mean rewriting all of that. A single hierarchy hanging ABOVE
-- properties means none of it changes: the tree is a dimension over properties,
-- not a replacement for them.

create type hierarchy_level as enum ('region', 'project', 'location', 'site');

create table org_nodes (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references orgs(id) on delete cascade,
  parent_id uuid,
  level     hierarchy_level not null,

  name text not null,
  code text,                      -- the client's own code for it, if they use one

  -- Materialised ancestry: '/<root id>/<child id>/…/<this id>/'. Both slashes
  -- matter. Without the leading one a prefix match on a path could align
  -- mid-identifier; without the trailing one '/abc' would prefix-match '/abcd'
  -- and silently pull a sibling subtree into someone's scope.
  path text not null,

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Cross-org parenting must be structurally impossible rather than merely
  -- disallowed by policy. A POC org placed a unit on TFML's property earlier in
  -- this build because the foreign key named only the parent id; the composite
  -- key is what fixed it, and the same shape applies here.
  constraint org_nodes_id_org_uniq unique (id, org_id),
  constraint org_nodes_parent_same_org_fk
    foreign key (parent_id, org_id) references org_nodes (id, org_id)
);

-- A name must be unique among its siblings. Two "Ikeja" projects in the same
-- region make every report ambiguous, and an import that resolves nodes by name
-- would have no way to choose between them.
create unique index org_nodes_sibling_name_uidx
  on org_nodes (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where deleted_at is null;

create unique index org_nodes_org_code_uidx
  on org_nodes (org_id, lower(code)) where code is not null and deleted_at is null;

-- Prefix matching is the whole point of the path, and it only uses an index with
-- an operator class suited to LIKE 'prefix%'.
create index org_nodes_path_idx on org_nodes (path text_pattern_ops);
create index org_nodes_org_level_idx on org_nodes (org_id, level) where deleted_at is null;
create index org_nodes_parent_idx on org_nodes (parent_id);

create trigger org_nodes_touch before update on org_nodes
  for each row execute function touch_updated_at();

create trigger audit_org_nodes after insert or update on org_nodes
  for each row execute function log_audit('hierarchy.write');

-- Retired, never deleted: a node's identifier appears in the path of everything
-- beneath it and in the audit trail of every property filed under it.
create trigger org_nodes_no_hard_delete before delete on org_nodes
  for each row execute function block_hard_delete();

-- ── The tree must actually be a tree ───────────────────────────────────────
--
-- Three invariants, enforced where they cannot be forgotten:
--   1. a region has no parent; every other level has one
--   2. a node's parent is exactly one level above it
--   3. the path is derived, never supplied
--
-- The level ordering is deliberately explicit rather than relying on the enum's
-- declaration order: adding a level later must be a considered change here, not
-- something that silently re-parents an existing tree.
create or replace function hierarchy_depth(p_level hierarchy_level)
returns integer language sql immutable as $$
  select case p_level
           when 'region'   then 1
           when 'project'  then 2
           when 'location' then 3
           when 'site'     then 4
         end;
$$;

create or replace function org_nodes_maintain_path()
returns trigger language plpgsql set search_path = public as $$
declare
  v_parent org_nodes%rowtype;
begin
  if new.parent_id is null then
    if new.level <> 'region' then
      raise exception 'a % must sit under a parent — only a region is a root', new.level;
    end if;
    new.path := '/' || new.id::text || '/';
  else
    select * into v_parent from org_nodes where id = new.parent_id;
    if v_parent.id is null then
      raise exception 'that parent does not exist';
    end if;
    if v_parent.deleted_at is not null then
      raise exception 'cannot file something under a retired %', v_parent.level;
    end if;
    if hierarchy_depth(new.level) <> hierarchy_depth(v_parent.level) + 1 then
      raise exception 'a % cannot sit directly under a % — the order is region, project, location, site',
        new.level, v_parent.level;
    end if;
    new.path := v_parent.path || new.id::text || '/';
  end if;

  return new;
end;
$$;

create trigger org_nodes_path before insert or update of parent_id, level on org_nodes
  for each row execute function org_nodes_maintain_path();

-- Re-parenting a node has to carry its whole subtree with it, or every
-- descendant's path becomes a lie and prefix-scoped access silently changes.
create or replace function org_nodes_cascade_path()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.path is distinct from old.path then
    update org_nodes
       set path = new.path || right(path, length(path) - length(old.path))
     where path like old.path || '_%'
       and org_id = new.org_id;
  end if;
  return null;
end;
$$;

create trigger org_nodes_path_cascade after update of path on org_nodes
  for each row execute function org_nodes_cascade_path();

-- ── Properties hang off a site ─────────────────────────────────────────────
--
-- Nullable on purpose, and it stays nullable. There are live properties in three
-- orgs; requiring a site in the same migration that introduces sites would break
-- every one of them. An unfiled property is fully operable — it simply does not
-- appear in a regional report until someone files it.
alter table properties add column if not exists site_node_id uuid;

alter table properties drop constraint if exists properties_site_same_org_fk;
alter table properties add constraint properties_site_same_org_fk
  foreign key (site_node_id, org_id) references org_nodes (id, org_id);

create index if not exists properties_site_node_idx on properties (site_node_id);

comment on column properties.site_node_id is
  'The SITE this property sits on. Nullable: an unfiled property is fully operable and simply absent from regional reporting.';

-- A property may only be filed under a SITE. Filing one directly under a region
-- would make "every property in this project" quietly incomplete.
create or replace function properties_site_must_be_a_site()
returns trigger language plpgsql set search_path = public as $$
declare
  v_level hierarchy_level;
begin
  if new.site_node_id is null then
    return new;
  end if;
  select level into v_level from org_nodes where id = new.site_node_id;
  if v_level is distinct from 'site' then
    raise exception 'a property is filed under a site, not a %', coalesce(v_level::text, 'missing node');
  end if;
  return new;
end;
$$;

create trigger properties_site_level before insert or update of site_node_id on properties
  for each row execute function properties_site_must_be_a_site();

-- ── Who may read and manage the tree ───────────────────────────────────────
alter table org_nodes enable row level security;

-- Everyone in the org reads the tree. It is the org chart of the portfolio: a
-- tenant seeing that a "North" region exists reveals nothing, and every screen
-- that groups by place needs it. What it contains is only names and codes.
create policy org_nodes_select on org_nodes for select to authenticated
  using (org_id = current_user_org_id() and deleted_at is null);

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('hierarchy.write', 'Properties', 'Manage the regional structure',
   'Create and rename regions, projects, locations and sites, and file properties under them. Restructuring the portfolio changes what every place-scoped report and every regionally-assigned manager can reach.',
   false, 46)
on conflict (key) do nothing;

create policy org_nodes_write on org_nodes for all to authenticated
  using (org_id = current_user_org_id() and (select has_permission('hierarchy.write')))
  with check (org_id = current_user_org_id() and (select has_permission('hierarchy.write')));

-- Seeded to admin only. B7 has no row for portfolio restructuring, and locked
-- decision 7 is explicit that silence means OFF — so this is named here as a
-- decision on the record rather than left to fall through the seed's default.
insert into role_permissions (org_id, role, capability, granted)
  select o.id, r.role, 'hierarchy.write', r.role = 'admin'
    from orgs o
    cross join (select unnest(array['tenant','vendor','fm_ops_staff','facility_manager',
                                    'finance_approver','property_owner','admin','viewer']::user_role[]) as role) r
on conflict (org_id, role, capability) do nothing;

-- ── Reading the tree ───────────────────────────────────────────────────────
--
-- Every property beneath a node, at any depth. One indexed prefix match rather
-- than a recursive CTE per query, which matters with B5's 100+ properties.
create or replace function properties_under_node(p_node_id uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id
    from properties p
    join org_nodes n  on n.id = p.site_node_id
    join org_nodes anc on anc.id = p_node_id
   where n.path like anc.path || '%'
     and n.org_id = anc.org_id          -- belt and braces; the composite FK already ensures it
     and p.org_id = anc.org_id
     and p.deleted_at is null
     and n.deleted_at is null;
$$;

revoke all on function properties_under_node(uuid) from public;
grant execute on function properties_under_node(uuid) to authenticated, service_role;

comment on function properties_under_node is
  'Every property beneath a hierarchy node at any depth, by indexed path prefix. The org check is redundant with the composite FK and kept anyway — this function decides what a regionally-assigned manager can reach.';

-- A readable label for reports and pickers: "North / Ikeja Project / Allen / Plot 7".
create or replace function node_full_name(p_node_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select string_agg(n.name, ' / ' order by hierarchy_depth(n.level))
    from org_nodes anc
    join org_nodes n on anc.path like n.path || '%' and n.org_id = anc.org_id
   where anc.id = p_node_id
     and n.deleted_at is null;
$$;

revoke all on function node_full_name(uuid) from public;
grant execute on function node_full_name(uuid) to authenticated, service_role;

-- ── Nigeria's geopolitical regions, per the board ──────────────────────────
--
-- Seeded for the two brand orgs only. The POC org is a demo fixture and is left
-- alone. Names follow the board's wording (North, South, East) rather than the
-- six-zone federal breakdown — the board asked for three.
insert into org_nodes (org_id, parent_id, level, name, code, path)
  select o.id, null, 'region', r.name, r.code, ''
    from orgs o
    cross join (values ('North', 'NR'), ('South', 'ST'), ('East', 'ET')) as r(name, code)
   where o.delivery_brand in ('TFML', 'OEA')
on conflict do nothing;
