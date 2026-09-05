-- The property manager administers the money on their own buildings
-- (decision 29, 5 Sept 2026).
--
-- Asked for as "the PM/RM role should be assigned service charge, leases & rent,
-- client funds create/edit rights as well." Decision 26 gave `sc.manage` and
-- `leases.write` to the regional manager five days ago and stopped there. This
-- gives the same two to the PROPERTY manager, and closes the read that both of
-- them were already missing.
--
-- ⚠️ `facility_manager` is deliberately NOT included, and this is the first time
-- the two decision-18 peers diverge. 0183 split them on the argument that OEA
-- staffs both disciplines and a brand-aware label could no longer tell them
-- apart; it also said they "hold identical grants on the day of the split, by
-- construction". That day has passed. TFML's FM maintains plant; OEA's PM lets
-- and administers tenancies, and it is the letting side that raises a service
-- charge, writes a lease and collects against it. Confirmed with the board
-- before writing this: PROPERTY_MANAGER and REGIONAL_MANAGER, not
-- facility_manager. The FM's own grants are untouched below — verified by the
-- suite, not by reading this comment.
--
-- 📌 What is NOT granted, and why the request does not need it:
--   • Ledger POSTING and account maintenance stay `admin`/`finance_approver`
--     (`ledger_*_insert`, `ledger_accounts_write`) — decision 16's "oversight
--     authorises; finance disburses" is untouched, and nothing here reaches
--     `assert_may_disburse`.
--   • `sc.read_all` stays denied, exactly as decision 26 denied it to the
--     regional manager: their reach is the place, not a blanket. The policies
--     they read through are already property-scoped.
--   • `records.export` is not touched. 0239 turned bulk export OFF for every
--     role including admin, four days ago, as a data-protection control whose
--     own text names the lever: the per-org permissions matrix. The download
--     features built on top of this decision are gated on that capability, so
--     an operator turning it on for a client's PM/RM is one audited toggle —
--     which is the sanctioned path, where quietly rewriting the baseline here
--     would have reversed a DPA control in a migration about something else.

-- ── 1. The two capabilities ──────────────────────────────────────────────────
--
-- Rebuilt from the LIVE catalogue (pg_get_functiondef), not retyped from 0246 —
-- 0183's rule, restated by 0236 after a draft written against a stale copy would
-- have silently handed an administrator `records.export` and taken tenancy
-- approval off the region. Exactly two lines differ from the live body.
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

        -- 0249. The property manager joins the payment officer here, and the
        -- facilities manager deliberately does not. Every write this unlocks is
        -- bounded to a property the holder actually manages, by the clause
        -- decision 26 put on sc_budgets_* and service_charges_* — this grants
        -- the capability, never the reach.
        when p_capability = 'sc.manage'
          then p_role in ('finance_approver', 'property_manager')

        -- 0249. leases.write reached no generic arm at all and fell to `else
        -- false`, so only admin and the regional manager held it.
        -- leases_write has carried `property_id in current_user_property_ids()`
        -- since 0090, so this is likewise capability-only.
        when p_capability = 'leases.write'
          then p_role = 'property_manager'

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
   and rp.role = 'property_manager'
   and rp.granted is distinct from b7_grants(rp.role, rp.capability);

-- ── 2. The desks that hold a building's money, named once ────────────────────
--
-- Decision 8's rule, and decision 19's correction to it in the same breath:
-- `current_user_property_ids()` does not filter on `relation`, so it answers
-- for a property OWNER exactly as for a manager. A bare
-- `property_id in (select current_user_property_ids())` branch on a LEDGER
-- policy would therefore hand every landlord their building's vendor payables
-- and this org's fee income — which is nobody's policy, and is precisely the
-- shape of the leak 0184 had to go back and close on `tickets_select`.
--
-- So the branch states which roles it is for, once, here.
create or replace function property_finance_roles()
returns user_role[]
language sql immutable set search_path = public as $fn$
  select array['property_manager', 'regional_manager']::user_role[];
$fn$;

comment on function property_finance_roles() is
  'The operational desks that administer money on the properties they hold — as opposed to org-wide oversight_roles() (0249).';

-- ── 3. What they can now see ─────────────────────────────────────────────────
--
-- 📌 The gap this closes is the one this codebase keeps finding: a writer
-- allowed and the matching reader denied. `payment_intents_insert` has admitted
-- facility_manager, property_manager and regional_manager since it was written,
-- while `payment_intents_select` gates on `oversight_roles()` — so a manager
-- could raise a collection and then could not see the row they had just
-- created, or whether it was ever paid. Same failure mode as 0216's vendor
-- UPDATE-policy-without-a-grant: nothing errors, the row simply is not there.
drop policy if exists payment_intents_select on payment_intents;
create policy payment_intents_select on payment_intents for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      payer_user_id = auth.uid()
      or current_user_role() = any (oversight_roles())
      or (
        current_user_role() = any (property_finance_roles())
        and property_id in (select current_user_property_ids())
      )
    )
  );

-- The fund position for a building they manage — readable now that 0247 gives
-- each property its own account rather than one pooled row per org. Before
-- 0247 there was nothing property-shaped here to scope to, which is why this
-- read could not have been granted safely at any earlier point.
drop policy if exists ledger_accounts_select on ledger_accounts;
create policy ledger_accounts_select on ledger_accounts for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or (
        current_user_role() = any (property_finance_roles())
        and property_id in (select current_user_property_ids())
      )
    )
  );

drop policy if exists ledger_postings_select on ledger_postings;
create policy ledger_postings_select on ledger_postings for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or (
        current_user_role() = any (property_finance_roles())
        and account_id in (
          select la.id from ledger_accounts la
           where la.org_id = current_user_org_id()
             and la.property_id in (select current_user_property_ids())
        )
      )
    )
  );

drop policy if exists ledger_entries_select on ledger_entries;
create policy ledger_entries_select on ledger_entries for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or (
        current_user_role() = any (property_finance_roles())
        and id in (
          select lp.entry_id from ledger_postings lp
            join ledger_accounts la on la.id = lp.account_id
           where la.org_id = current_user_org_id()
             and la.property_id in (select current_user_property_ids())
        )
      )
    )
  );

revoke all on function property_finance_roles() from public, anon;
grant execute on function property_finance_roles() to authenticated, service_role;

-- ── 4. Proof, not prose ──────────────────────────────────────────────────────
do $$
declare
  v_bad text;
begin
  -- The two capabilities landed on the property manager.
  if not b7_grants('property_manager', 'sc.manage')
     or not b7_grants('property_manager', 'leases.write') then
    raise exception 'the property manager did not receive sc.manage and leases.write';
  end if;

  -- And did NOT land on the facilities manager. This is the whole point of the
  -- divergence, so it fails the migration rather than being left to a suite.
  if b7_grants('facility_manager', 'sc.manage')
     or b7_grants('facility_manager', 'leases.write') then
    raise exception 'the facilities manager was granted a lettings capability it must not hold';
  end if;

  -- Nothing above widened an org-wide read.
  if b7_grants('property_manager', 'sc.read_all')
     or b7_grants('regional_manager', 'sc.read_all') then
    raise exception 'sc.read_all leaked to a place-scoped role';
  end if;

  -- 0239's export control is untouched.
  if b7_grants('admin', 'records.export')
     or b7_grants('property_manager', 'records.export')
     or b7_grants('regional_manager', 'records.export') then
    raise exception 'records.export is no longer off by default — 0239 was reversed by accident';
  end if;

  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in ('property_finance_roles', 'b7_grants');
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
