-- The tenancy ladder, restored to the baseline and stated once.
--
-- Board, 31 Aug 2026, answering what 0244 exposed. `b7_baseline()` made the
-- seeder comparable against the rows for the first time, and they disagreed on
-- four pairs -- all of them decision 10's two-tier tenant review:
--
--   FM/PM        applications.recommend    granted in rows, NOT in the seeder
--   Payment Off. applications.approve      granted in rows, NOT in the seeder
--   Executive    applications.approve      granted in rows, NOT in the seeder
--   Executive    applications.review_all   granted in rows, NOT in the seeder
--
-- ⚠️ `reset_org_permissions_to_b7` deletes every row and reseeds, so pressing
-- "Reset to B7" would have DISMANTLED tenant review: nobody below the regional
-- manager could recommend, and neither finance nor the executive could approve.
-- A governance button that quietly removes a separation-of-duties control is
-- worse than no button. `0205` was written to restore "the applications block
-- 0153 dropped"; a later rebuild of the CASE dropped it a second time, keeping
-- only the regional manager arm's copies.
--
-- ── The ladder, as decided ────────────────────────────────────────────────
--
--   recommend -> facility manager / properties manager, PROPERTY-scoped
--   approve   -> regional manager, REGION-scoped; org administrator as fallback
--
-- Both halves were ALREADY scoped correctly and neither function changes here.
-- `record_application_recommendation` and `record_application_approval` both
-- gate on `applications.review_all OR a.property_id in (select
-- current_user_property_ids())`, so:
--   • an FM/PM reaches the applications on properties they hold
--   • a regional manager reaches their region, because that resolver expands
--     the node subtree -- which is why `applications.review_all` must NOT be
--     granted to them, exactly as 0205 says
--   • an administrator holds review_all through the blanket admin grant and is
--     therefore the org-wide fallback
-- The scoping does the work; this migration only restores who holds the two
-- capabilities.
--
-- 📌 Finance and the executive LOSE `applications.approve`, and the executive
-- loses `applications.review_all`. That is not a narrowing invented here: it is
-- what `0225` decided when it moved tenancy approval onto the region, and what
-- the seeder has said ever since. The ROWS were the stale half.
--
-- The CASE below is pg_get_functiondef's, with one capability added to the
-- FM/PM branch and nothing else retyped -- 0183's rule, fifth application.

create or replace function b7_grants(p_role user_role, p_capability text)
returns boolean
language sql immutable set search_path = public as $fn$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        when p_role = 'admin' then true

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          -- 0238. They hold BOTH, and that is not a contradiction: the
          -- maker-checker in approve_vendor_application is per application and
          -- per person, so a regional manager who recommended one must hand it
          -- to a colleague or the administrator. Holding both is what lets a
          -- region run without an administrator in the loop for every vendor;
          -- it is not permission to do both on the same application.
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         -- 0238: the FM/PM put a contractor forward. They do
                         -- NOT hold vendors.approve, which is the whole change.
                         'vendors.recommend',
                         -- Board, 31 Aug 2026. Restored: this is the FIRST tier of
                         -- decision 10's two-tier tenant review, and the seeder had
                         -- silently lost it. record_application_recommendation is
                         -- already scoped to `applications.review_all OR property_id
                         -- in current_user_property_ids()`, so granting it here is
                         -- property-scoped by construction, not by a second rule.
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')
        when p_capability = 'sc.manage'    then p_role = 'finance_approver'
        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$fn$;

comment on function b7_grants is
  'Whether B7 -- the board-approved baseline -- grants one capability to one role. THE definition: seed_b7_permissions provisions from it and b7_baseline() reports it. 0245 restored the tenancy ladder: applications.recommend to the FM/PM (property-scoped by the function that reads it), applications.approve to the regional manager (region-scoped) with the administrator as org-wide fallback.';

-- ── Bringing the rows to the baseline ─────────────────────────────────────
--
-- `set_by is null` again: a row an operator deliberately moved is theirs, and
-- this migration must not silently undo a decision while claiming to restore
-- one. Untouched rows are the ones the baseline speaks for.
--
-- Written as "make every unedited row equal b7_grants" rather than as four
-- hand-listed changes, because a diff-shaped fix is what 0185 was written
-- about: state the rule, not the instances.
update role_permissions rp
   set granted = b7_grants(rp.role, rp.capability), set_at = now()
  from orgs o
 where o.id = rp.org_id
   and o.deleted_at is null
   and rp.set_by is null
   and rp.capability in ('applications.recommend', 'applications.approve',
                         'applications.review_all')
   and rp.granted is distinct from b7_grants(rp.role, rp.capability);
