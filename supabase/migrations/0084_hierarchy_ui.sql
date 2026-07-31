-- Day 8.75. The board asked for REGION → PROJECT → LOCATION → SITE (0066) and got
-- the schema, the resolver extension (0067), and the invitation wiring (0078c,
-- 0081) — all of it enforced, none of it visible. There has never been a screen
-- to create a region, file a property under a site, or assign a regional manager
-- to one. This closes that: a retire function with the same "refuse if it would
-- orphan something" shape as `retire_property`, and the two read surfaces the UI
-- needs in one query each rather than N+1.

-- ── Retiring a node must not orphan what is beneath it ─────────────────────
--
-- A node can be retired only once nothing depends on it: no live child node,
-- and — since only a SITE ever carries a property (0066's own trigger enforces
-- that) — no live property filed directly on it. Retiring a project that still
-- holds a location would not touch the location's own `deleted_at`, but every
-- read that starts from the tree (`org_nodes_select` filters `deleted_at is
-- null`) would lose the parent hop and the location would become unreachable
-- from the top — the same silent-orphan shape `retire_property` already guards
-- against for units.
create or replace function retire_org_node(p_node_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  n org_nodes%rowtype;
  v_children integer;
  v_properties integer;
begin
  select * into n from org_nodes where id = p_node_id;
  if n.id is null then
    raise exception 'that node could not be found';
  end if;
  if n.org_id is distinct from current_user_org_id() and auth.uid() is not null then
    raise exception 'that node belongs to another organisation';
  end if;
  if n.deleted_at is not null then
    return; -- already retired; idempotent
  end if;
  if auth.uid() is not null and not has_permission('hierarchy.write') then
    raise exception 'you do not have permission to restructure the portfolio';
  end if;

  select count(*) into v_children from org_nodes
   where parent_id = p_node_id and deleted_at is null;
  if v_children > 0 then
    raise exception
      'this % still has % active child node(s) — retire those first', n.level, v_children;
  end if;

  select count(*) into v_properties from properties
   where site_node_id = p_node_id and deleted_at is null;
  if v_properties > 0 then
    raise exception
      'this % still has % active propert(y/ies) filed under it — move or retire those first', n.level, v_properties;
  end if;

  update org_nodes set deleted_at = now() where id = p_node_id;
end;
$$;

revoke all on function retire_org_node(uuid) from public;
grant execute on function retire_org_node(uuid) to authenticated, service_role;

comment on function retire_org_node is
  'Retires a hierarchy node once nothing depends on it — no live child node, no live property filed on it. Mirrors retire_property''s refuse-rather-than-orphan shape.';

-- ── The tree, with counts, in one query ─────────────────────────────────────
--
-- Without this every screen that wants "how many properties under this site"
-- either fans out into N+1 queries or duplicates `properties_under_node`'s
-- prefix match inline. security_invoker: the caller's own `org_nodes_select`
-- policy decides what rows come back, this view only adds columns to them.
create or replace view org_nodes_overview
with (security_invoker = on) as
  select
    n.id, n.org_id, n.parent_id, n.level, n.name, n.code, n.path, n.created_at,
    (select count(*) from org_nodes c
      where c.parent_id = n.id and c.deleted_at is null)             as child_count,
    (select count(*) from properties p
      where p.site_node_id = n.id and p.deleted_at is null)          as direct_property_count,
    (select count(*) from properties_under_node(n.id))               as subtree_property_count
  from org_nodes n
 where n.deleted_at is null;

comment on view org_nodes_overview is
  'The hierarchy tree with child and property counts precomputed, so the tree screen is one query instead of N+1. security_invoker — org_nodes_select already decides what a caller may see.';

grant select on org_nodes_overview to authenticated;

-- ── Properties gain their place in the tree, appended (0082's lesson: `create
-- or replace view` can only add columns at the end, never insert mid-list) ──
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
      where a.property_id = p.id and a.deleted_at is null)              as asset_count,
    p.site_node_id,
    case when p.site_node_id is not null then node_full_name(p.site_node_id) end as node_path
  from properties p
 where p.deleted_at is null;

comment on view property_summary is
  'Per-property counts for the portfolio list, plus its place in the regional hierarchy. Scalar subqueries, not joins. security_invoker.';

grant select on property_summary to authenticated;
