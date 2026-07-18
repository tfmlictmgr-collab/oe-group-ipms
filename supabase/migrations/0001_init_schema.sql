-- OE Group IPMS — initial schema (Pathway A, Day 1)
-- Tables per Master Build Prompt v3.1 Part B / B7 Role x Report Access Matrix.
-- RLS enforces org_id isolation (multi-tenant backstop) plus role-based scoping per B7.

create extension if not exists pgcrypto;

-- ── ENUMS ────────────────────────────────────────────────────────────────

create type delivery_brand as enum ('TFML', 'OEA', 'direct');

create type user_role as enum (
  'tenant', 'vendor', 'fm_ops_staff', 'facility_manager',
  'finance_approver', 'property_owner', 'admin'
);

create type ticket_channel as enum ('whatsapp', 'telegram', 'portal', 'email');
create type ticket_category as enum ('maintenance', 'billing', 'vendor', 'complaint', 'general');
create type ticket_urgency as enum ('critical', 'high', 'normal', 'low');
create type ticket_status as enum ('open', 'in_progress', 'resolved', 'closed');

create type payment_status as enum (
  'pending_verification', 'verified', 'pending_evaluation',
  'recommended', 'pending_approval', 'approved', 'remitted', 'rejected'
);

-- ── TABLES ───────────────────────────────────────────────────────────────

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  delivery_brand delivery_brand not null default 'direct',
  parent_org_id uuid references orgs(id),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references orgs(id),
  role user_role not null,
  full_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index users_org_id_idx on users(org_id);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  sender_id uuid references users(id),
  channel ticket_channel not null,
  channel_sender_ref text,
  message_text text not null,
  category ticket_category,
  urgency ticket_urgency,
  summary text,
  property_or_unit text,
  requires_human_review boolean not null default false,
  status ticket_status not null default 'open',
  created_at timestamptz not null default now()
);
create index tickets_org_id_idx on tickets(org_id);
create index tickets_status_idx on tickets(status);
create index tickets_sender_id_idx on tickets(sender_id);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  user_id uuid references users(id),
  name text not null,
  service_category text,
  contact_email text,
  contact_phone text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index vendors_org_id_idx on vendors(org_id);

create table vendor_evaluations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  vendor_id uuid not null references vendors(id),
  evaluated_by uuid references users(id),
  quality_score numeric(5,2),
  response_score numeric(5,2),
  completion_score numeric(5,2),
  satisfaction_score numeric(5,2),
  compliance_score numeric(5,2),
  composite_score numeric(6,3) generated always as (
    coalesce(quality_score, 0) * 0.30 +
    coalesce(response_score, 0) * 0.20 +
    coalesce(completion_score, 0) * 0.20 +
    coalesce(satisfaction_score, 0) * 0.20 +
    coalesce(compliance_score, 0) * 0.10
  ) stored,
  period text,
  notes text,
  created_at timestamptz not null default now()
);
create index vendor_evaluations_org_id_idx on vendor_evaluations(org_id);
create index vendor_evaluations_vendor_id_idx on vendor_evaluations(vendor_id);

create table service_charges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  billed_to_user_id uuid references users(id),
  property_or_unit text,
  billing_period text,
  amount numeric(14,2) not null,
  status text not null default 'invoiced',
  due_date date,
  created_at timestamptz not null default now()
);
create index service_charges_org_id_idx on service_charges(org_id);
create index service_charges_billed_to_user_id_idx on service_charges(billed_to_user_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  vendor_id uuid not null references vendors(id),
  invoice_reference text,
  amount numeric(14,2) not null,
  status payment_status not null default 'pending_verification',
  service_verified_by uuid references users(id),
  service_verified_at timestamptz,
  performance_validated boolean not null default false,
  approved_by uuid references users(id),
  approved_at timestamptz,
  remittance_reference text,
  created_at timestamptz not null default now()
);
create index payments_org_id_idx on payments(org_id);
create index payments_vendor_id_idx on payments(vendor_id);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  actor_id uuid references users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_id_idx on audit_log(org_id);
create index audit_log_actor_id_idx on audit_log(actor_id);

-- ── RLS HELPERS ──────────────────────────────────────────────────────────
-- security definer so RLS on `users` itself doesn't recurse when other
-- tables' policies look up the caller's org_id/role.

create or replace function current_user_org_id()
returns uuid
language sql security definer stable
set search_path = public
as $$
  select org_id from users where id = auth.uid();
$$;

create or replace function current_user_role()
returns user_role
language sql security definer stable
set search_path = public
as $$
  select role from users where id = auth.uid();
$$;

-- ── RLS POLICIES ─────────────────────────────────────────────────────────

alter table orgs enable row level security;
alter table users enable row level security;
alter table tickets enable row level security;
alter table vendors enable row level security;
alter table vendor_evaluations enable row level security;
alter table service_charges enable row level security;
alter table payments enable row level security;
alter table audit_log enable row level security;

-- orgs: visible only to members of that org
create policy orgs_select on orgs for select
  using (id = current_user_org_id());

-- users: self always visible; admin/facility_manager/finance_approver see all in-org
create policy users_select on users for select
  using (
    org_id = current_user_org_id()
    and (
      id = auth.uid()
      or current_user_role() in ('admin', 'facility_manager', 'finance_approver')
    )
  );

-- tickets — B7: tenant/vendor/fm_ops_staff see own (sender); facility_manager,
-- finance_approver, admin see all in-org.
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      sender_id = auth.uid()
      or current_user_role() in ('admin', 'facility_manager', 'finance_approver')
    )
  );

create policy tickets_insert on tickets for insert
  with check (
    org_id = current_user_org_id()
    and sender_id = auth.uid()
  );

create policy tickets_update on tickets for update
  using (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager')
  );

-- vendors — B7: vendor sees own record; admin/facility_manager/finance_approver see all.
create policy vendors_select on vendors for select
  using (
    org_id = current_user_org_id()
    and (
      user_id = auth.uid()
      or current_user_role() in ('admin', 'facility_manager', 'finance_approver')
    )
  );

create policy vendors_write on vendors for all
  using (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager')
  )
  with check (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager')
  );

-- vendor_evaluations — B7: vendor sees own scorecard; admin/facility_manager/finance_approver see all.
create policy vendor_evaluations_select on vendor_evaluations for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() in ('admin', 'facility_manager', 'finance_approver')
      or vendor_id in (select id from vendors where user_id = auth.uid())
    )
  );

create policy vendor_evaluations_write on vendor_evaluations for insert
  with check (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager')
  );

-- service_charges — B7: tenant/property_owner see own bill; admin/facility_manager/finance_approver see all.
create policy service_charges_select on service_charges for select
  using (
    org_id = current_user_org_id()
    and (
      billed_to_user_id = auth.uid()
      or current_user_role() in ('admin', 'facility_manager', 'finance_approver')
    )
  );

create policy service_charges_write on service_charges for all
  using (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'finance_approver')
  )
  with check (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'finance_approver')
  );

-- payments (vendor remittance) — B7: vendor sees own pay status; facility_manager
-- sees managed vendors; finance_approver/admin see + approve all.
create policy payments_select on payments for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() in ('admin', 'facility_manager', 'finance_approver')
      or vendor_id in (select id from vendors where user_id = auth.uid())
    )
  );

create policy payments_insert on payments for insert
  with check (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager')
  );

create policy payments_update on payments for update
  using (
    org_id = current_user_org_id()
    and current_user_role() in ('admin', 'facility_manager', 'finance_approver')
  );

-- audit_log — B7: admin/finance_approver see all-in-org; everyone else sees only their own actions.
-- No client-side insert policy: entries are written server-side (service role / triggers), per
-- the immutable-audit-log guardrail (CLAUDE.md A3).
create policy audit_log_select on audit_log for select
  using (
    org_id = current_user_org_id()
    and (
      actor_id = auth.uid()
      or current_user_role() in ('admin', 'finance_approver')
    )
  );
