-- Audit 0729b: a regional manager was not regional, and two views leaked.
--
-- ── S1 (High) · `regional_manager` held `applications.review_all` ──────────
--
-- `0072b` seeded it, and its own header three lines above says the role has
-- "Nothing financial, no org-wide read." The capability is defined as *"Read
-- every tenant application in the organisation, not only those for properties
-- they are attached to"* — precisely the org-wide read the comment denied.
--
-- Two consequences, the second worse than the first:
--   • a regional manager read every applicant's identity documents in the org,
--     not just their own region's
--   • `application_document_requirements` is write-gated on the same capability,
--     so they could rewrite what documents EVERY property in the org demands
--
-- The role loses nothing it should have. Applications carry `property_id` since
-- `0076`, so a regional manager reaches their own region's applications through
-- `property_id in (select current_user_property_ids())` — which now expands the
-- node subtree. Scoping does the work the over-grant was doing, correctly.
--
-- ⚠️ Worth naming: **the comment and the code disagreed in the same file, and the
-- comment was the one that was right.** I wrote both. A prose claim about access
-- is not enforcement, and the verification suite asserted only that the role held
-- *no financial* capability and no `tickets.read_all` — never that it held no
-- org-wide read of applications. A guard you did not think to assert is a guard
-- you do not have.

create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager']::user_role[]
    loop
      v_granted := case
        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned',
          'applications.review_all'
        )

        -- A regional manager is a facility manager with a wider remit INSIDE
        -- their own region. Every capability here is bounded by the property
        -- scoping in the policy that reads it; `applications.review_all` is not,
        -- which is exactly why it was removed (audit 0729b-S1).
        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read'
        )

        when cap.key in ('tickets.read_all', 'assets.read',
                         'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r = 'facility_manager'

        when cap.key = 'vendors.read' then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        -- B7 silent → OFF.
        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- Revoke what is already out there. `seed_b7_permissions` only inserts, so a row
-- granted by the previous version would otherwise stand forever.
update role_permissions
   set granted = false
 where role = 'regional_manager'
   and capability = 'applications.review_all'
   and granted;

-- An executive SHOULD hold it — oversight sees everything finance sees, and B7
-- gives the MD/Managing Partner an org-wide row. Stated here rather than left to
-- the earlier seed, which never named it.
update role_permissions
   set granted = true
 where role = 'executive'
   and capability = 'applications.review_all'
   and not granted;

-- ── S2 (Medium) · portfolio vacancy was readable by every authenticated role ──
--
-- `property_application_windows` restricts to the caller's ORG but not to who
-- they are, and a plain view reads its base tables with the VIEW OWNER's rights —
-- so `properties` RLS never applied. A tenant or a vendor could read the unit
-- count, vacancy count and intake state of every property in the organisation.
-- Commercially sensitive, and it is occupancy data about other people's homes.
--
-- `security_invoker` makes the view read as the caller, so the existing
-- `properties` policies decide. Nobody who should see it loses anything.
create or replace view property_application_windows
with (security_invoker = on) as
  select
    p.id            as property_id,
    p.org_id,
    p.name,
    p.applications_state,
    p.applications_state_note,
    p.applications_state_set_at,
    property_accepts_applications(p.id)                       as accepting_now,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null)    as unit_count,
    (select count(*) from units u
      where u.property_id = p.id and u.deleted_at is null
        and u.occupant_user_id is null)                       as vacant_count
  from properties p
 where p.org_id = current_user_org_id()
   and p.deleted_at is null;

comment on view property_application_windows is
  'Per-property intake state and the vacancy behind it. `security_invoker`, so the caller''s own `properties` policies decide what they see — without it a tenant could read the occupancy of every property in the org (audit 0729b-S2).';

-- ── S3 (Low) · a comment that claimed a protection the view did not have ─────
--
-- `stakeholder_assignments` was commented "Definer-free: it reads through the
-- caller's own policies". It had no `security_invoker`, so that was simply untrue
-- — it happened to be safe because its explicit WHERE clause repeats the same
-- test, which is a coincidence one edit away from being wrong.
--
-- An inaccurate comment about access control is worse than none: the next person
-- reads it, believes the boundary is handled elsewhere, and relaxes the WHERE.
create or replace view stakeholder_assignments
with (security_invoker = on) as
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
  'Assignments with their scope resolved to a readable label. `security_invoker` — actually, not merely asserted in a comment: the WHERE clause is a narrowing, not the boundary (audit 0729b-S3).';
