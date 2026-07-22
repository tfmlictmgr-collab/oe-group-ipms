-- Property-scoped RBAC (B7 precision for Facility Manager & Property Owner).
-- Adds a stakeholder model (who manages / owns which property) and links tickets
-- to a property, then rewrites the read policies so FM/owner see only their
-- properties' data instead of everything (FM) or nothing (owner).

create type property_relation as enum ('manager', 'owner');

create table property_stakeholders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  property_id uuid not null references properties(id),
  user_id uuid not null references users(id),
  relation property_relation not null,
  created_at timestamptz not null default now(),
  unique (property_id, user_id, relation)
);
create index property_stakeholders_user_idx on property_stakeholders(user_id);
create index property_stakeholders_property_idx on property_stakeholders(property_id);

-- Link tickets to a property (nullable — channel tickets may be unlinked).
alter table tickets add column property_id uuid references properties(id);
create index tickets_property_idx on tickets(property_id);

-- Helper: the set of property ids the caller stakes (manager OR owner).
-- SECURITY DEFINER so policies referencing it don't recurse into the
-- stakeholder table's own RLS.
create or replace function current_user_property_ids()
returns setof uuid language sql security definer stable set search_path = public as $$
  select property_id from property_stakeholders where user_id = auth.uid();
$$;

alter table property_stakeholders enable row level security;
create policy property_stakeholders_select on property_stakeholders for select
  using (org_id = current_user_org_id()
    and (user_id = auth.uid()
      or current_user_role() = any (array['admin','finance_approver']::user_role[])));
create policy property_stakeholders_write on property_stakeholders for all
  using (org_id = current_user_org_id() and current_user_role() = 'admin')
  with check (org_id = current_user_org_id() and current_user_role() = 'admin');

-- ── Rewrite read policies: FM/owner scoped to staked properties ─────────────
-- Admin + finance keep org-wide read (B7: finance = read-only all). FM is
-- removed from the blanket lists and instead sees its managed properties;
-- owner gains access to its owned properties. Tenant (sender) and vendor/ops
-- (assignee) clauses are unchanged.

drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
      or current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists service_charges_select on service_charges;
create policy service_charges_select on service_charges for select
  using (
    org_id = current_user_org_id()
    and (
      billed_to_user_id = auth.uid()
      or current_user_role() = any (array['admin','finance_approver']::user_role[])
      or budget_id in (
        select id from sc_budgets where property_id in (select current_user_property_ids())
      )
    )
  );

drop policy if exists sc_budgets_select on sc_budgets;
create policy sc_budgets_select on sc_budgets for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    )
  );

drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or id in (select current_user_property_ids())
    )
  );

drop policy if exists units_select on units;
create policy units_select on units for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','finance_approver']::user_role[])
      or property_id in (select current_user_property_ids())
    )
  );
