-- A resident can read the unit they occupy (needed so a portal request can be
-- auto-linked to their property, and generally correct per B7 — a tenant relates
-- to their own unit). Extends units_select with an occupant self clause.

drop policy if exists units_select on units;
create policy units_select on units for select
  using (
    org_id = current_user_org_id()
    and (
      occupant_user_id = auth.uid()
      or current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    )
  );
