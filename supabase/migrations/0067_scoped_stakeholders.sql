-- Assign a manager to a REGION and let every property beneath it follow.
--
-- The board asked for decentralised FM/PM administration: a manager in the region
-- holding limited administrative functions there, rather than one central
-- administrator for the whole portfolio. The place half of that is here; the
-- capability half follows in the next step.
--
-- `property_stakeholders` gains a nullable `node_id`, and the ONE resolver every
-- policy already calls learns to expand it.
--
-- Extending `current_user_property_ids()` rather than adding a second scoping
-- function is the deliberate choice. Two mechanisms answering the same question is
-- how the `tickets.triage_unassigned` grant came to contradict the B7 baseline
-- yesterday, and how the ledger account resolver ended up applied in half the
-- places that needed it. This function is referenced 42 times across 13
-- migrations; there is exactly one of it, and it stays that way.

alter table property_stakeholders add column if not exists node_id uuid;

-- Same-org enforcement as a structural fact, not a policy clause.
alter table property_stakeholders drop constraint if exists property_stakeholders_node_same_org_fk;
alter table property_stakeholders add constraint property_stakeholders_node_same_org_fk
  foreign key (node_id, org_id) references org_nodes (id, org_id);

-- `property_id` was NOT NULL. An assignment is now to a property OR to a node —
-- exactly one of them, never both and never neither. Encoding "assigned to a
-- region" as an absent property_id would repeat this week's mistake twice over:
-- NULL means unknown, never "this other thing instead".
alter table property_stakeholders alter column property_id drop not null;

alter table property_stakeholders drop constraint if exists property_stakeholders_one_scope;
alter table property_stakeholders add constraint property_stakeholders_one_scope
  check (
    (property_id is not null and node_id is null)
    or (property_id is null and node_id is not null)
  );

-- The old uniqueness constraint only covered property assignments, so the same
-- person could be attached to one region twice.
create unique index if not exists property_stakeholders_node_uidx
  on property_stakeholders (node_id, user_id, relation) where node_id is not null;

create index if not exists property_stakeholders_node_idx on property_stakeholders (node_id);

comment on column property_stakeholders.node_id is
  'Assignment to a hierarchy node instead of a single property. Every property beneath it resolves, including ones added later — which is the point: a regional manager should not need re-assigning each time their region gains a property.';

-- ── The one resolver, extended ─────────────────────────────────────────────
create or replace function current_user_property_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  -- Directly assigned properties, exactly as before.
  select s.property_id
    from property_stakeholders s
   where s.user_id = auth.uid()
     and s.property_id is not null

  union

  -- Everything beneath a node they are assigned to, at any depth.
  --
  -- The org comparison is between the node rows and is therefore redundant with
  -- the composite foreign keys above. It is kept because this is the function
  -- that decides what a regionally-assigned manager can reach, and a redundant
  -- check costs one comparison while its absence would cost a cross-brand leak.
  select p.id
    from property_stakeholders s
    join org_nodes anc on anc.id = s.node_id and anc.org_id = s.org_id
    join org_nodes n   on n.path like anc.path || '%' and n.org_id = anc.org_id
    join properties p  on p.site_node_id = n.id and p.org_id = anc.org_id
   where s.user_id = auth.uid()
     and s.node_id is not null
     and anc.deleted_at is null
     and n.deleted_at is null
     and p.deleted_at is null;
$$;

comment on function current_user_property_ids is
  'Every property this user may reach: directly assigned, plus everything beneath any hierarchy node they are assigned to. The single scoping resolver — referenced by 42 policy clauses. Extend it here; never add a second.';

-- ── Reading and writing an assignment ──────────────────────────────────────
--
-- 0008 restricted these policies by role name. The matrix governs this now, and
-- assigning someone to a region is a materially larger act than assigning them to
-- one property, so it belongs with portfolio structure rather than with people
-- administration.
drop policy if exists property_stakeholders_select on property_stakeholders;
create policy property_stakeholders_select on property_stakeholders for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      user_id = auth.uid()                                  -- your own assignments
      or (select has_permission('properties.read_all'))
      or (select has_permission('hierarchy.write'))
    )
  );

drop policy if exists property_stakeholders_write on property_stakeholders;
create policy property_stakeholders_write on property_stakeholders for all to authenticated
  using (org_id = current_user_org_id() and (select has_permission('hierarchy.write')))
  with check (org_id = current_user_org_id() and (select has_permission('hierarchy.write')));

-- ── Who is assigned where, for the UI ──────────────────────────────────────
create or replace view stakeholder_assignments as
  select
    s.id, s.org_id, s.user_id, s.relation,
    s.property_id, s.node_id,
    u.full_name, u.email, u.role,
    case when s.node_id is not null then node_full_name(s.node_id) else p.name end as scope_label,
    case when s.node_id is not null then n.level::text else 'property' end        as scope_level,
    case when s.node_id is not null
         then (select count(*) from properties_under_node(s.node_id))
         else 1 end                                                               as property_count,
    s.created_at
  from property_stakeholders s
  join users u      on u.id = s.user_id
  left join properties p on p.id = s.property_id
  left join org_nodes n  on n.id = s.node_id
 where s.org_id = current_user_org_id()
   and (
     s.user_id = auth.uid()
     or has_permission('properties.read_all')
     or has_permission('hierarchy.write')
   );

comment on view stakeholder_assignments is
  'Assignments with their scope resolved to a readable label and a property count. Definer-free: it reads through the caller''s own policies, so it cannot show more than they may already see.';

revoke all on stakeholder_assignments from anon, authenticated;
grant select on stakeholder_assignments to authenticated;
