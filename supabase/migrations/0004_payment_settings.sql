-- Vendor Payment Administration config (Module 4, Day 10).
-- Admin-configurable gate thresholds per B4 / B7 ("approver limits
-- admin-configurable"). The payments table itself already exists (0001).

create table payment_settings (
  org_id uuid primary key references orgs(id),
  min_performance_score numeric(5,2) not null default 70,      -- KPI gate
  approval_threshold_amount numeric(14,2) not null default 1000000, -- finance sign-off above this
  updated_at timestamptz not null default now()
);

alter table payment_settings enable row level security;

-- All staff can read the thresholds; only admin configures them (B7).
create policy payment_settings_select on payment_settings for select
  using (org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[]));
create policy payment_settings_write on payment_settings for all
  using (org_id = current_user_org_id() and current_user_role() = 'admin')
  with check (org_id = current_user_org_id() and current_user_role() = 'admin');
