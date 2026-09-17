-- The payment approver sees what the payment officer sees, and still cannot
-- release a naira.
--
-- Board, 3 Sept 2026. Reported as a 404: pressing Statement on a property threw
-- "This page could not be found". Measured across every money role on two real
-- properties, which is what turned one report into three findings:
--
--   payment officer    Lake River 1 row   Parkview 1 row
--   payment approver   Lake River 0 -> 404   Parkview 0 -> 404
--   payment auditor    Lake River 0 -> 404   Parkview 0 -> 404
--   executive          1 row              1 row
--   administrator      1 row              1 row
--   regional manager   0 (holds neither)  1 row  <- correct scoping, not a bug
--
-- `property_statement` answers "no row" to a caller who holds neither the
-- property nor oversight, and the page renders that as 404 on purpose, so the
-- URL cannot be used to discover which property ids are real. The refusal was
-- right; the membership was wrong.
--
-- 📌 `oversight_roles()` is `{admin, finance_approver, executive}` -- written
-- before `0151` created `payment_audit_approver` and `payment_approver`. This
-- is the THIRD instance of that exact omission: `0157` fixed it for `payments`
-- and `remittances`, `0222` for `users`, and the statements were never asked.
-- Each time the symptom is different and the cause is the same sentence.
--
-- ── What this changes ─────────────────────────────────────────────────────
--
--   1. `payment_approver` joins `oversight_roles()`.
--   2. Their capability arm becomes the payment officer's, exactly.
--
-- The board's rule is "everything the payment officer has except disbursement",
-- and the reason that is safe to state as a SET rather than maintained as a
-- trimmed list is measurable: disbursement is not a capability. Releasing money
-- is guarded by an explicit `finance_approver` literal inside
-- `assert_may_disburse` and `enforce_payment_transition` -- verified, neither
-- reads `oversight_roles()` -- so nothing granted here can reach it.
--
-- ⚠️ What joining `oversight_roles()` actually confers, counted rather than
-- assumed: 25 SELECT policies (the ledger, payments, remittances, the audit
-- trail, leases, rent charges, bank accounts, reconciliations, statements) and
-- 6 write clauses -- `leases_write`, `sc_budgets_insert/update/delete`,
-- `service_charges_insert/update`. In every one of those six the resolver sits
-- in `capability AND (oversight OR place)`, so membership removes the PLACE
-- restriction and never the capability: a payment approver can administer a
-- service charge because `sc.manage` is granted above, org-wide because their
-- remit is the organisation, and they still cannot touch leases, because
-- `leases.write` is not theirs -- the payment officer does not hold it either.
--
-- 📌 The AUDITOR is deliberately left out and is owed its own decision. B7's
-- Payment Auditor row reads "--" for SC & financials while decision 23 says
-- "the auditor sees every detail". A property''s full rent statement is wider
-- than the payment they are auditing, and widening an audit role is not a
-- thing to do as a side effect of fixing somebody else''s 404.

create or replace function oversight_roles()
returns user_role[]
language sql immutable set search_path = public as $fn$
  -- ⚠️ `payment_approver` joined on 0246. `payment_audit_approver` did NOT --
  -- see the note above. Adding a role here grants every money READ in the
  -- system; it grants no disbursement, which is guarded by an explicit
  -- finance_approver literal elsewhere and not by this list.
  select array['admin', 'finance_approver', 'executive', 'payment_approver']::user_role[];
$fn$;

comment on function oversight_roles is
  'Who may SEE money and the audit trail -- one definition, per decision 9. admin, the payment officer, the executive and (0246) the payment approver. Membership confers reads, and on the six write policies that name it, only the bypass of the PLACE clause -- never the capability. It confers no disbursement: that is an explicit finance_approver check in assert_may_disburse and enforce_payment_transition.';

-- ── The capability arm ────────────────────────────────────────────────────
--
-- 0183''s rule for the sixth time: the body below is pg_get_functiondef''s with
-- one arm extended and nothing else retyped.

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

        -- 0246. The payment approver is the senior accounting desk: it holds
        -- everything the payment officer holds, and the difference between them
        -- is DISBURSEMENT, which is not a capability at all. Releasing money is
        -- guarded by an explicit `finance_approver` literal inside
        -- `assert_may_disburse` and `enforce_payment_transition`, so nothing
        -- granted here can reach it — that is what makes "the same set" safe to
        -- state rather than a list somebody has to keep trimming.
        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all',
          'assets.read', 'sc.read_all', 'sc.manage'
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

-- Bring existing orgs to it. `set_by is null` as always: a row an operator
-- deliberately moved stays where they put it.
update role_permissions rp
   set granted = b7_grants(rp.role, rp.capability), set_at = now()
  from orgs o
 where o.id = rp.org_id
   and o.deleted_at is null
   and rp.set_by is null
   and rp.role = 'payment_approver'
   and rp.granted is distinct from b7_grants(rp.role, rp.capability);
