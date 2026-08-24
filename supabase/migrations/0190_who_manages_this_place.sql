-- The reverse of `current_user_property_ids()`: given a property, who manages it?
-- (Board direction, 22 Aug 2026.)
--
-- An administrator holds `tickets.assign` on every request in the organisation
-- and always will — that is what B7's "All (RT)" row means and nothing here
-- changes it. What the board asked for is narrower and is about DEFAULTS: a
-- request on a property that already has a facilities or property manager is
-- **theirs** to dispatch, and an administrator reaching past them should be
-- doing something deliberate rather than something the screen invited.
--
-- To say that on screen, the page has to answer "does this place already have
-- an owner", and nothing could. `current_user_property_ids()` runs the other
-- way — it answers "which properties does THIS CALLER reach" — and asking it
-- per-user across the organisation to invert it would be both slow and the
-- second scoping mechanism decision 8 forbids.
--
-- ⚠️ This is NOT a second scoping mechanism. It grants nothing and is read by
-- no policy; it reports. The two halves of the resolver stay identical on
-- purpose — a direct `property_stakeholders` row, or a node anywhere above the
-- property's site — so a manager who reaches a property through their region
-- is named here exactly as one assigned to the building itself. If those two
-- ever disagree the screen would tell an administrator a property is unowned
-- while the FM is looking at it on their own board.
create or replace function property_managers(p_property_id uuid)
returns table(user_id uuid, full_name text, email text, role user_role)
language sql stable security definer set search_path = public as $$
  -- Directly assigned to the property.
  select distinct u.id, u.full_name, u.email, u.role
    from property_stakeholders s
    join users u on u.id = s.user_id
   where s.property_id = p_property_id
     and s.relation = 'manager'
     and u.role = any (fm_roles())
     and u.deactivated_at is null

  union

  -- Assigned to a node the property hangs beneath, at any depth. Mirrors the
  -- path-prefix walk in current_user_property_ids(), read in the other
  -- direction.
  select distinct u.id, u.full_name, u.email, u.role
    from properties p
    join org_nodes site on site.id = p.site_node_id and site.org_id = p.org_id
    join org_nodes anc  on site.path like anc.path || '%' and anc.org_id = site.org_id
    join property_stakeholders s on s.node_id = anc.id and s.relation = 'manager'
    join users u on u.id = s.user_id
   where p.id = p_property_id
     and p.deleted_at is null
     and site.deleted_at is null
     and anc.deleted_at is null
     and u.role = any (fm_roles())
     and u.deactivated_at is null;
$$;

revoke all on function property_managers(uuid) from public, anon;
grant execute on function property_managers(uuid) to authenticated;

comment on function property_managers is
  'The facilities/property/regional managers who reach a given property — directly assigned, or through any hierarchy node above it. The reverse of current_user_property_ids(), and deliberately NOT a scoping mechanism: it grants nothing, no policy reads it, and it exists so a screen can say "this place already has an owner" before offering an administrator a dispatch control that is really somebody else''s job. SECURITY DEFINER so the caller need not be able to read property_stakeholders org-wide to be told a property is spoken for.';
