-- A regional manager supersedes the FM/PM below them, and the operational desk
-- can see the budget on a building it holds.
--
-- Board, 30 Aug 2026. Four findings, reported from the live OEA portal, and the
-- first of them is not a grant at all.
--
-- ── 1. The read was never the problem ─────────────────────────────────────
--
-- "Service Charges is missing for a property manager" reads like a missing
-- capability and is not one. `sc_budgets_select` has been
--
--     oversight_roles() OR property_id in (select current_user_property_ids())
--
-- since 0055, and `service_charges_select` reaches the same rows through
-- `budget_id`. An FM, a PM and a regional manager have therefore been able to
-- READ the budgets on properties they hold for as long as those policies have
-- existed. What hid the module was `seesServiceCharges` in the dashboard
-- layout, derived as `can('sc.read_all') || can('sc.manage')` — neither of
-- which any operational role holds.
--
-- ⚠️ So this migration does NOT grant `sc.read_all`, and granting it would be
-- the wrong fix twice over. Its own description is "read every service charge,
-- not only their own" — it is the ORG-WIDE capability, and decision 9 gives a
-- regional manager "nothing financial, no org-wide read". Handing it out to
-- make a menu item appear would trade a property-scoped read the policies
-- already do correctly for an unscoped one. The nav was wrong; the nav is what
-- changes, in the application layer.
--
-- ── 2. hierarchy.write was admin-only, against decision 8 ─────────────────
--
-- Decision 8 says, in its own words: "The FM/PM builds the tree while filing a
-- property. Location, project and site are created inline from the property
-- form by anyone holding `hierarchy.write` — a picker that can only select is a
-- dead end for the first property in a new city." Measured live on both orgs:
-- `hierarchy.write` was granted to `admin` and nobody else, because it is named
-- in no branch of `seed_b7_permissions` and fell to its `else false`. The
-- decision was recorded and never implemented.
--
-- ── 3. The regional manager's own two grants ──────────────────────────────
--
-- `sc.manage` and `leases.write`. This is a B7 amendment, minuted rather than
-- assumed: B7's Regional Manager row reads "—" for SC & financials, and
-- decision 9 said "nothing financial". The board's position on 30 Aug 2026 is
-- that a role which supersedes the FM/PM over a wider place cannot be unable to
-- administer the service charge and the tenancies on the buildings it holds.
-- `role_rank` has ranked them 60 against the FM/PM's 50 since 0183; this makes
-- the authority match the rank.
--
-- ⚠️ It is bounded by place, not by trust — which is the whole of §4.
--
-- ── 4. The write policies were org-wide, and now say where ────────────────
--
-- `sc_budgets_insert/update/delete` tested `has_permission('sc.manage')` and
-- the org, and NOTHING about which property. That was harmless while the only
-- holder was `finance_approver`, whose remit is the whole organisation. It
-- stops being harmless the moment a regional manager holds it: without this
-- section, granting `sc.manage` in §3 would let a manager in the South raise a
-- budget against a building in Kano.
--
-- So the three write policies gain the clause `leases_write` has carried since
-- 0090 — oversight anywhere, everyone else only where they hold the property.
-- Admin, finance and the executive are all in `oversight_roles()`, so their
-- reach is byte-identical to before; the clause exists entirely to bound the
-- role §3 adds. `service_charges_insert/update` move from a hardcoded
-- ('admin','finance_approver') pair to the same capability-plus-place test, so
-- that generating the invoices is reachable by exactly whoever may raise the
-- budget they come from.
--
-- 📌 Not fixed here, recorded: `service_charges` has no DELETE policy and a
-- `service_charges_no_hard_delete` trigger, so `generateInvoices`'s
-- delete-then-reinsert clears nothing under RLS and would duplicate a budget's
-- invoices on a regenerate. It is guarded today only by the UI disabling the
-- button once `status = 'invoiced'`. This migration does not widen that risk —
-- the same UI guard covers the role it adds — but the guard is in the wrong
-- layer and wants its own turn.

-- 📌 The function below is the LIVE catalogue definition with exactly two
-- lines changed, extracted with pg_get_functiondef rather than retyped from
-- the migration that last wrote it. That is `0183`'s rule, and it earned its
-- keep here: this migration was first drafted against `0205`'s body, which is
-- four changes stale. `0233` added `records.export then false`, and `0225`
-- moved `applications.approve` from the executive to the regional manager.
-- Retyping would have silently reverted both — handing an administrator
-- `records.export` and taking tenancy approval back off the region.

-- ── The baseline ──────────────────────────────────────────

create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when cap.key = 'tickets.assign_without_review' then false
        when cap.key = 'training.read' then false
        when cap.key = 'records.export' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          -- 0225: the region decides its own tenancies. Bounded to their node
          -- subtree by record_application_approval's own property check, which
          -- is why `applications.review_all` must NOT be here.
          'applications.recommend', 'applications.approve',
          -- 0236. `sc.manage` and `leases.write` are safe here ONLY because
          -- this migration put the place clause into the three sc_budgets
          -- write policies; without it they would reach the whole org.
          -- `sc.read_all` is still absent and still must be: it is the
          -- org-wide read decision 9 denies this role.
          'hierarchy.write', 'sc.manage', 'leases.write'
        )

        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write')
          then r in ('facility_manager', 'property_manager')

        when cap.key = 'vendors.read'
          then r in ('facility_manager', 'property_manager', 'finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read'
          then r in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$fn$;

comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 training.read, +0205 applications block, +0225 tenancy approval to the region, +0233 records.export, +0236 hierarchy.write for the FM/PM and hierarchy.write/sc.manage/leases.write for the regional manager). A capability not named here falls to else false -- decision 7 "B7 silent means OFF".';

-- ── Bringing existing orgs to the amended baseline ────────────────────────
--
-- ⚠️ `set_by is null` is the whole of the WHERE clause, and it is deliberate.
-- Decision 7 makes a deviation from B7 a visible, intentional act with an
-- audited author; `set_by` is that author. A row someone has deliberately moved
-- is left exactly where they put it, so this migration cannot silently undo an
-- administrator's decision while claiming to update a baseline. Untouched rows
-- carry `set_by = null` and are the ones the baseline still speaks for.
update role_permissions rp
   set granted = true, set_at = now()
 where rp.set_by is null
   and rp.granted = false
   and (
     (rp.role = 'regional_manager'
        and rp.capability in ('hierarchy.write', 'sc.manage', 'leases.write'))
     or (rp.role in ('facility_manager', 'property_manager')
        and rp.capability = 'hierarchy.write')
   );

-- ── The place clause on the service-charge writes ─────────────────────────

drop policy if exists sc_budgets_insert on sc_budgets;
create policy sc_budgets_insert on sc_budgets for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists sc_budgets_update on sc_budgets;
create policy sc_budgets_update on sc_budgets for update to authenticated
  using (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or property_id in (select current_user_property_ids())
    )
  )
  with check (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists sc_budgets_delete on sc_budgets;
create policy sc_budgets_delete on sc_budgets for delete to authenticated
  using (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or property_id in (select current_user_property_ids())
    )
  );

comment on policy sc_budgets_insert on sc_budgets is
  'sc.manage, and the place. Oversight raises a budget anywhere in its own org; everyone else only on a property they hold. The place clause was added by 0236 so that granting sc.manage to a regional manager could not reach a building outside their region -- it is the same clause leases_write has carried since 0090.';

-- ── The invoices that come out of that budget ─────────────────────────────
--
-- Previously `current_user_role() = any (array['admin','finance_approver'])`.
-- Both of those hold `sc.manage` and both are in `oversight_roles()`, so this
-- is the same set of rows for them and additionally admits whoever else may
-- raise the budget these invoices are apportioned from. Scoped through
-- `budget_id`, because that is the column that knows which property this is.
drop policy if exists service_charges_insert on service_charges;
create policy service_charges_insert on service_charges for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or budget_id in (
        select b.id from sc_budgets b
         where b.property_id in (select current_user_property_ids())
      )
    )
  );

drop policy if exists service_charges_update on service_charges;
create policy service_charges_update on service_charges for update to authenticated
  using (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or budget_id in (
        select b.id from sc_budgets b
         where b.property_id in (select current_user_property_ids())
      )
    )
  )
  with check (
    org_id = current_user_org_id()
    and (select has_permission('sc.manage'))
    and (
      current_user_role() = any (oversight_roles())
      or budget_id in (
        select b.id from sc_budgets b
         where b.property_id in (select current_user_property_ids())
      )
    )
  );

comment on policy service_charges_insert on service_charges is
  'sc.manage, and the place, reached through budget_id. Replaces a hardcoded (admin, finance_approver) pair -- both of which hold sc.manage and sit in oversight_roles(), so their reach is unchanged. 0236.';
