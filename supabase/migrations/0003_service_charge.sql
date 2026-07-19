-- Service Charge Administration (Module 3, Day 9).
-- Model: property → units (each with an apportionment factor, e.g. floor area)
-- → annual sc_budget of shared costs → per-unit invoices in service_charges,
-- apportioned pro-rata by factor.

create table properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  address text,
  created_at timestamptz not null default now()
);
create index properties_org_id_idx on properties(org_id);

create table units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  property_id uuid not null references properties(id),
  label text not null,
  apportionment_factor numeric(12,2) not null default 1, -- e.g. floor area (sqm)
  occupant_user_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index units_org_id_idx on units(org_id);
create index units_property_id_idx on units(property_id);

create table sc_budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  property_id uuid not null references properties(id),
  period text not null,               -- e.g. '2026'
  description text,
  total_amount numeric(14,2) not null, -- total shared cost to apportion
  status text not null default 'draft', -- draft | invoiced
  created_at timestamptz not null default now()
);
create index sc_budgets_org_id_idx on sc_budgets(org_id);
create index sc_budgets_property_id_idx on sc_budgets(property_id);

-- link generated invoices back to their unit + budget
alter table service_charges add column unit_id uuid references units(id);
alter table service_charges add column budget_id uuid references sc_budgets(id);
alter table service_charges add column apportionment_pct numeric(7,4);

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table properties enable row level security;
alter table units enable row level security;
alter table sc_budgets enable row level security;

-- properties/units: staff (admin/FM/finance) read; admin/FM manage.
-- Tenants never query these directly — their statement reads service_charges,
-- which carries denormalized property/unit labels.
create policy properties_select on properties for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[]));
create policy properties_write on properties for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[]));

create policy units_select on units for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[]));
create policy units_write on units for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[]));

-- budgets: admin/finance own the financials; FM read-only.
create policy sc_budgets_select on sc_budgets for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[]));
create policy sc_budgets_write on sc_budgets for all
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','finance_approver']::user_role[]));
