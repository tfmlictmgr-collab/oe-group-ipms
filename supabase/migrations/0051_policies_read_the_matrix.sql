-- Policies stop naming roles and start asking the matrix.
--
-- This is the migration that makes the toggles real. Until now a switch could be
-- flipped and nothing would change, because the policies were still testing
-- `current_user_role() = 'facility_manager'` directly.
--
-- Three rules held throughout:
--
-- 1. ORG ISOLATION IS NOT A CAPABILITY. `org_id = current_user_org_id()` stays in
--    every policy, untouched and un-toggleable. No permission can widen it.
--
-- 2. PROPERTY SCOPING SURVIVES. An FM/PM with `assets.write` may still only write
--    on properties they are attached to. The capability says WHETHER, the attaché
--    assignment says WHERE. Losing that distinction would turn one toggle into
--    org-wide access.
--
-- 3. OWN-RECORD ACCESS IS NOT A CAPABILITY EITHER. A tenant seeing their own
--    request, a vendor seeing their own job — those are identity, not privilege,
--    and cannot be revoked by a switch. Only the "see everyone's" half is
--    governed.
--
-- The locked capabilities (payments, ledger, bank, audit, permissions, admin
-- invitation, channel credentials) are NOT converted. Their policies keep naming
-- roles, which is exactly what "non-delegable" means.

-- ── Requests ───────────────────────────────────────────────────────────────
drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      -- Identity, never revocable.
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
      -- Privilege, governed.
      or has_permission('tickets.read_all')
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists tickets_update on tickets;
create policy tickets_update on tickets for update
  using (
    org_id = current_user_org_id()
    and (
      has_permission('tickets.assign')
      or has_permission('tickets.close')
      -- The assignee acknowledging their own job.
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
    )
  );

-- ── Assets ─────────────────────────────────────────────────────────────────
drop policy if exists assets_select on assets;
create policy assets_select on assets for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      -- Org-wide reading is the capability; property-scoped reading is the
      -- attaché assignment and remains available to whoever holds it.
      has_permission('assets.read')
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists assets_insert on assets;
create policy assets_insert on assets for insert
  with check (
    org_id = current_user_org_id()
    and has_permission('assets.write')
    and (
      -- An administrator writes org-wide; anyone else only where they are
      -- staked. Expressed as "has no attaché scope" rather than "is admin", so
      -- the rule follows the assignment rather than the role name.
      current_user_role() = 'admin'
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists assets_update on assets;
create policy assets_update on assets for update
  using (
    org_id = current_user_org_id()
    and has_permission('assets.write')
    and (
      current_user_role() = 'admin'
      or property_id in (select current_user_property_ids())
    )
  )
  with check (
    org_id = current_user_org_id()
    and has_permission('assets.write')
    and (
      current_user_role() = 'admin'
      or property_id in (select current_user_property_ids())
    )
  );

-- ── Vendors ────────────────────────────────────────────────────────────────
drop policy if exists vendors_select on vendors;
create policy vendors_select on vendors for select
  using (
    org_id = current_user_org_id()
    and (user_id = auth.uid() or has_permission('vendors.read'))
  );

drop policy if exists vendors_write on vendors;
create policy vendors_write on vendors for all
  using (org_id = current_user_org_id() and has_permission('vendors.write'))
  with check (org_id = current_user_org_id() and has_permission('vendors.write'));

drop policy if exists vendor_evaluations_write on vendor_evaluations;
create policy vendor_evaluations_write on vendor_evaluations for insert
  with check (org_id = current_user_org_id() and has_permission('vendors.evaluate'));

-- ── Portfolio ──────────────────────────────────────────────────────────────
drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    org_id = current_user_org_id()
    and (
      has_permission('properties.read_all')
      or id in (select current_user_property_ids())
    )
  );

drop policy if exists properties_write on properties;
create policy properties_write on properties for all
  using (org_id = current_user_org_id() and has_permission('properties.write'))
  with check (org_id = current_user_org_id() and has_permission('properties.write'));

drop policy if exists units_write on units;
create policy units_write on units for all
  using (
    org_id = current_user_org_id()
    and (has_permission('properties.write') or has_permission('units.assign_occupant'))
  )
  with check (
    org_id = current_user_org_id()
    and (has_permission('properties.write') or has_permission('units.assign_occupant'))
  );

-- ── Service charge ─────────────────────────────────────────────────────────
drop policy if exists service_charges_select on service_charges;
create policy service_charges_select on service_charges for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      -- A tenant reading their own bill. Identity.
      billed_to_user_id = auth.uid()
      or has_permission('sc.read_all')
      or budget_id in (
        select id from sc_budgets
         where property_id in (select current_user_property_ids())
      )
    )
  );

drop policy if exists sc_budgets_write on sc_budgets;
create policy sc_budgets_write on sc_budgets for all
  using (org_id = current_user_org_id() and has_permission('sc.manage'))
  with check (org_id = current_user_org_id() and has_permission('sc.manage'));

-- Admin retains everything by virtue of holding every configurable capability
-- in the B7 seed — not by being special-cased here. If an operator ever revokes
-- one from admin, the database honours that, which is the whole point of a
-- matrix over hardcoded roles.
