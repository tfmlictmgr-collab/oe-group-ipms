-- Day 2 (S5) — extend property-scoping to the money side.
-- Before this, a facility_manager could read EVERY vendor payment and evaluation
-- in the org, not just those for the properties they manage (0008/0009 only
-- scoped tickets + service charges). Payments are sensitive cross-remit money
-- data, so an FM at one estate could see payouts at another.
--
-- Fix: an explicit vendor↔property association (governance-legible, and works
-- before a vendor has any tickets), then scope payments + vendor_evaluations for
-- facility_manager to vendors associated with a property they manage. Admin and
-- finance_approver still see everything; a vendor still sees only its own rows.
-- The vendor DIRECTORY stays org-visible to FMs (they need it to assign work) —
-- the sensitive money/performance data is what gets scoped.

create table vendor_properties (
  vendor_id uuid not null references vendors(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  org_id uuid not null references orgs(id),
  created_at timestamptz not null default now(),
  primary key (vendor_id, property_id)
);
create index vendor_properties_property_idx on vendor_properties (property_id);
create index vendor_properties_org_idx on vendor_properties (org_id);

alter table vendor_properties enable row level security;

-- Staff of the org can read the associations; admin/FM manage them.
create policy vendor_properties_select on vendor_properties for select
  using (org_id = current_user_org_id());
create policy vendor_properties_write on vendor_properties for all
  using (org_id = current_user_org_id() and current_user_role() in ('admin', 'facility_manager'))
  with check (org_id = current_user_org_id() and current_user_role() in ('admin', 'facility_manager'));

create trigger audit_vendor_property_write
  after insert or update or delete on vendor_properties
  for each row execute function log_audit('vendor_property.write');

-- Vendors associated with a property the current user manages.
create or replace function current_user_scoped_vendor_ids()
returns setof uuid language sql security definer stable set search_path = public as $$
  select vendor_id from vendor_properties
  where property_id in (select current_user_property_ids());
$$;

-- ── Re-scope payments: FM limited to their properties' vendors ───────────────
drop policy payments_select on payments;
create policy payments_select on payments for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() in ('admin', 'finance_approver')
      or vendor_id in (select id from vendors where user_id = auth.uid())      -- vendor: own
      or (current_user_role() = 'facility_manager'
          and vendor_id in (select current_user_scoped_vendor_ids()))          -- FM: managed only
    )
  );

-- FM may only act on payments for their own vendors (finance/admin unrestricted).
-- The 0010 trigger still confines money-moving transitions to finance/admin.
drop policy payments_update on payments;
create policy payments_update on payments for update
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() in ('admin', 'finance_approver')
      or (current_user_role() = 'facility_manager'
          and vendor_id in (select current_user_scoped_vendor_ids()))
    )
  );

-- ── Re-scope vendor_evaluations the same way ─────────────────────────────────
drop policy vendor_evaluations_select on vendor_evaluations;
create policy vendor_evaluations_select on vendor_evaluations for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() in ('admin', 'finance_approver')
      or vendor_id in (select id from vendors where user_id = auth.uid())      -- vendor: own scorecard
      or (current_user_role() = 'facility_manager'
          and vendor_id in (select current_user_scoped_vendor_ids()))          -- FM: managed only
    )
  );
