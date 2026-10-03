-- Reading leases is a switch, off for facilities managers (requested 3 Oct 2026).
--
-- `leases_select` admitted anyone holding the property — so a facilities
-- manager read every lease, rent figure and arrears line on their buildings,
-- and the menu offered them Leases & Rent and the Tenancy Schedule because they
-- recommend tenancy applications. Recommending happens under People → Tenancy
-- Applications and needs neither. Decision 29 put letting and its money with
-- the property manager.
--
-- New capability `leases.read` (Lettings). The property branch of
-- `leases_select` now also asks it. The tenant's own row and oversight are
-- untouched. `rent_charges` and `lease_notices` read through `leases` in their
-- own policies, and `rent_roll` / `tenancy_schedule` are security_invoker
-- views over it, so all four follow without being rewritten.
--
-- Baseline: every role that read leases through a property before, except
-- `facility_manager` and `fm_ops_staff` (B7: their own jobs, nothing else). The operator can turn it back on per org in the matrix.

set local lock_timeout = '5s';

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('leases.read', 'Lettings', 'Read leases and the tenancy schedule',
   'See the leases, rents, collections and arrears on properties they manage — Leases & Rent and the Tenancy Schedule. Off by default for facilities managers. An administrator and oversight always read them.',
   false, 47)
on conflict (key) do nothing;

CREATE OR REPLACE FUNCTION public.b7_grants(p_role user_role, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        -- 0310. The Executive's own powers, as switches. Placed above the admin
        -- arm so an administrator is not shown holding two Executive-only
        -- powers that mean nothing for their role.
        when p_capability = 'requisitions.approve_within_limit' then p_role = 'operations_executive'
        when p_capability = 'operations.org_wide' then p_role = 'operations_executive'
        when p_capability = 'requisitions.raise' then p_role in (
          'fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        -- 0311. Raising planned work, split out of tickets.assign (dispatching a
        -- reported request) so the operator can switch one without the other.
        -- Baseline is exactly who held tickets.assign.
        when p_capability = 'workorders.raise' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        -- 0312. Verifying the service on a vendor invoice and running its
        -- performance check — the first two steps of the payment gate. Baseline
        -- is every role the invoice screen offered those buttons to.
        when p_capability = 'payments.verify_service' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'finance_approver', 'admin'
        )

        -- 0313. Opening or closing a property's tenancy applications.
        -- Baseline: exactly the two roles set_property_application_state named.
        when p_capability = 'applications.open_close' then p_role in ('admin', 'executive')

        -- 0314. Reading leases and the tenancy schedule on properties they
        -- hold. Everyone who read them through their properties before keeps
        -- it, except the facilities manager (decision 29: the FM maintains
        -- plant; the PM lets and administers tenancies) and dispatched ops
        -- staff (B7: their own jobs and nothing else).
        when p_capability = 'leases.read' then p_role in (
          'property_manager', 'regional_manager', 'operations_executive',
          'executive', 'property_owner', 'finance_approver',
          'payment_approver', 'payment_audit_approver', 'admin'
        )

        when p_role = 'admin' then true

        -- 0281. Placed ABOVE the role-specific arms deliberately: those arms are
        -- closed lists, and a capability added to the bottom of this CASE would
        -- never be reached for `executive`, `regional_manager` or either payment
        -- desk. The three confirmation desks are absent by intent, not omission
        -- — recording a claim disqualifies you from confirming it (0282's
        -- maker-checker), so granting it to a chain role hands them a way to
        -- take themselves out of the chain. `finance_approver` is the deliberate
        -- exception: taking a walk-in payment at the finance desk is the single
        -- commonest way one of these arrives, and the consequence — that a
        -- colleague must confirm it — is the control working, exactly as 0142
        -- says. 13 Sept 2026: unchanged by the board's reversal above — the
        -- Officer still takes the walk-in, the Approver still confirms it, and
        -- a walk-in the Officer takes is confirmed by someone else regardless.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver',
          'operations_executive'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        -- 0309: everything a facilities/properties/regional manager holds,
        -- organisation-wide, plus the org-wide reads 0307 gave. Bounded by
        -- `current_user_property_ids()`, which for the Executive is every
        -- property in their organisation.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite',
          'assets.write', 'assets.import',
          'vendors.write', 'vendors.evaluate', 'vendors.recommend', 'vendors.approve',
          'properties.write', 'units.assign_occupant', 'hierarchy.write',
          'applications.recommend', 'applications.approve',
          'sc.manage', 'leases.write'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246, unchanged by 13 Sept 2026's reversal: the payment approver is
        -- the senior accounting desk and already held sc.manage before this
        -- migration. What moved is who else does.
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
                         'vendors.recommend',
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 13 Sept 2026 (board). Was `p_role in ('finance_approver',
        -- 'property_manager')` since 0249. The Payment Officer's role narrows
        -- to disbursement; administering the service-charge budget and its
        -- apportionment is not part of "dispensing outward payments" and moves
        -- fully to the Approver, who already held it via the closed-list arm
        -- above. property_manager's own grant (0249) is untouched — every
        -- write it unlocks is still bounded to a property they hold.
        when p_capability = 'sc.manage'
          then p_role = 'property_manager'

        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$function$;

do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

drop policy if exists leases_select on leases;
create policy leases_select on leases for select to authenticated using (
  org_id = current_user_org_id()
  and deleted_at is null
  and (
    tenant_user_id = auth.uid()
    or current_user_role() = any (oversight_roles())
    or (property_id in (select current_user_property_ids())
        and (select has_permission('leases.read')))
  )
);

do $$
begin
  if b7_grants('facility_manager', 'leases.read') or not b7_grants('property_manager', 'leases.read') then
    raise exception '0314: leases.read baseline is wrong';
  end if;
  if position('leases.read' in (select qual from pg_policies where policyname = 'leases_select')) = 0 then
    raise exception '0314: leases_select must ask leases.read';
  end if;
end $$;
