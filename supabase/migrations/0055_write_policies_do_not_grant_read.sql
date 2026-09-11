-- A `FOR ALL` policy grants SELECT too, and that made the matrix lie.
--
-- Revoking `vendors.read` from the FM left them still seeing every vendor. The
-- read policy correctly denied — `has_permission('vendors.read')` returned
-- false — but `vendors_write` was declared `FOR ALL`, and in Postgres that
-- covers SELECT as well as INSERT/UPDATE/DELETE. Permissive policies OR
-- together, so holding `vendors.write` silently re-granted read.
--
-- This was invisible before Day 6.5 because the two role lists were identical
-- (admin + FM could both read and write vendors), so the redundant grant never
-- differed from the intended one. The moment the two became independently
-- toggleable, one started overriding the other.
--
-- That is the specific danger of a permission matrix over hardcoded roles: the
-- screen states a position the database does not hold, and an administrator who
-- revokes a capability is told it is off. A permission UI that can be wrong
-- about the database is worse than no permission UI, because it is believed.
--
-- Every write policy on a matrix-governed table is therefore split into explicit
-- INSERT / UPDATE / DELETE. Read is granted by the read policy alone.
--
-- The money and configuration tables (bank_accounts, ledger_accounts,
-- payment_settings, payout_recipients, reconciliations, bank_statement_lines)
-- keep `FOR ALL`: their capabilities are LOCKED, their read and write role lists
-- are identical by design, and they are deliberately not part of the matrix. A
-- redundant grant that cannot be independently toggled cannot drift.

-- ── Vendors ────────────────────────────────────────────────────────────────
drop policy if exists vendors_write on vendors;

create policy vendors_insert on vendors for insert
  with check (org_id = current_user_org_id() and (select has_permission('vendors.write')));

create policy vendors_update on vendors for update
  using (org_id = current_user_org_id() and (select has_permission('vendors.write')))
  with check (org_id = current_user_org_id() and (select has_permission('vendors.write')));

create policy vendors_delete on vendors for delete
  using (org_id = current_user_org_id() and (select has_permission('vendors.write')));

-- ── Properties ─────────────────────────────────────────────────────────────
drop policy if exists properties_write on properties;

create policy properties_insert on properties for insert
  with check (org_id = current_user_org_id() and (select has_permission('properties.write')));

create policy properties_update on properties for update
  using (org_id = current_user_org_id() and (select has_permission('properties.write')))
  with check (org_id = current_user_org_id() and (select has_permission('properties.write')));

create policy properties_delete on properties for delete
  using (org_id = current_user_org_id() and (select has_permission('properties.write')));

-- ── Units ──────────────────────────────────────────────────────────────────
drop policy if exists units_write on units;

create policy units_insert on units for insert
  with check (
    org_id = current_user_org_id()
    and ((select has_permission('properties.write'))
         or (select has_permission('units.assign_occupant')))
  );

create policy units_update on units for update
  using (
    org_id = current_user_org_id()
    and ((select has_permission('properties.write'))
         or (select has_permission('units.assign_occupant')))
  )
  with check (
    org_id = current_user_org_id()
    and ((select has_permission('properties.write'))
         or (select has_permission('units.assign_occupant')))
  );

create policy units_delete on units for delete
  using (org_id = current_user_org_id() and (select has_permission('properties.write')));

-- ── Service charge ─────────────────────────────────────────────────────────
drop policy if exists sc_budgets_write on sc_budgets;

create policy sc_budgets_insert on sc_budgets for insert
  with check (org_id = current_user_org_id() and (select has_permission('sc.manage')));

create policy sc_budgets_update on sc_budgets for update
  using (org_id = current_user_org_id() and (select has_permission('sc.manage')))
  with check (org_id = current_user_org_id() and (select has_permission('sc.manage')));

create policy sc_budgets_delete on sc_budgets for delete
  using (org_id = current_user_org_id() and (select has_permission('sc.manage')));

-- service_charges_write is FOR ALL and role-based (admin/finance write the
-- invoices). Its READ policy is matrix-governed via `sc.read_all`, so the same
-- override applies: split it.
drop policy if exists service_charges_write on service_charges;

create policy service_charges_insert on service_charges for insert
  with check (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
  );

create policy service_charges_update on service_charges for update
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
  )
  with check (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[])
  );

-- No DELETE policy: 0010 forbids hard-deleting a service charge outright
-- (soft-delete only), so granting one would only produce confusing failures.
