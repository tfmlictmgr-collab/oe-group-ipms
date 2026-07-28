-- Evaluate each permission ONCE per query, not once per row.
--
-- 0051 called `has_permission('x')` bare inside the policy expression. Postgres
-- treats that as a per-ROW predicate: on a 10,000-row asset register it makes
-- 10,000 identical lookups, every one returning the same answer, because a
-- user's role and org cannot change mid-statement.
--
-- Wrapping it in a scalar subquery — `(select has_permission('x'))` — lets the
-- planner hoist it to an InitPlan and evaluate it exactly once. This is the
-- standard Supabase RLS optimisation and it is not a micro-optimisation here:
-- these policies sit in front of every read the application makes, and B5 puts
-- 100+ properties on this system from day one.
--
-- Nothing about WHO can see WHAT changes. Same predicates, evaluated once.

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
      or (select has_permission('tickets.read_all'))
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists tickets_update on tickets;
create policy tickets_update on tickets for update
  using (
    org_id = current_user_org_id()
    and (
      (select has_permission('tickets.assign'))
      or (select has_permission('tickets.close'))
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
      (select has_permission('assets.read'))
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists assets_insert on assets;
create policy assets_insert on assets for insert
  with check (
    org_id = current_user_org_id()
    and (select has_permission('assets.write'))
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
    and (select has_permission('assets.write'))
    and (
      current_user_role() = 'admin'
      or property_id in (select current_user_property_ids())
    )
  )
  with check (
    org_id = current_user_org_id()
    and (select has_permission('assets.write'))
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
    and (user_id = auth.uid() or (select has_permission('vendors.read')))
  );

drop policy if exists vendors_write on vendors;
create policy vendors_write on vendors for all
  using (org_id = current_user_org_id() and (select has_permission('vendors.write')))
  with check (org_id = current_user_org_id() and (select has_permission('vendors.write')));

drop policy if exists vendor_evaluations_write on vendor_evaluations;
create policy vendor_evaluations_write on vendor_evaluations for insert
  with check (org_id = current_user_org_id() and (select has_permission('vendors.evaluate')));

-- ── Portfolio ──────────────────────────────────────────────────────────────
drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    org_id = current_user_org_id()
    and (
      (select has_permission('properties.read_all'))
      or id in (select current_user_property_ids())
    )
  );

drop policy if exists properties_write on properties;
create policy properties_write on properties for all
  using (org_id = current_user_org_id() and (select has_permission('properties.write')))
  with check (org_id = current_user_org_id() and (select has_permission('properties.write')));

drop policy if exists units_write on units;
create policy units_write on units for all
  using (
    org_id = current_user_org_id()
    and ((select has_permission('properties.write')) or (select has_permission('units.assign_occupant')))
  )
  with check (
    org_id = current_user_org_id()
    and ((select has_permission('properties.write')) or (select has_permission('units.assign_occupant')))
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
      or (select has_permission('sc.read_all'))
      or budget_id in (
        select id from sc_budgets
         where property_id in (select current_user_property_ids())
      )
    )
  );

drop policy if exists sc_budgets_write on sc_budgets;
create policy sc_budgets_write on sc_budgets for all
  using (org_id = current_user_org_id() and (select has_permission('sc.manage')))
  with check (org_id = current_user_org_id() and (select has_permission('sc.manage')));

-- Admin retains everything by virtue of holding every configurable capability
-- in the B7 seed — not by being special-cased here. If an operator ever revokes
-- one from admin, the database honours that, which is the whole point of a
-- matrix over hardcoded roles.
