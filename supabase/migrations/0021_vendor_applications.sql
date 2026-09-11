-- Public vendor self-registration.
--
-- This is the FIRST unauthenticated write path in the system, so the design is
-- deliberately defensive:
--
--   1. Applications land in their own table and NEVER touch `vendors`. An
--      applicant therefore cannot exist as an assignable or payable vendor
--      until a human approves — which matters because Day 4 makes vendors
--      payable for real.
--   2. anon may INSERT only. No SELECT, no UPDATE, no DELETE — so the endpoint
--      cannot be used to enumerate applicants, orgs, or existing vendors.
--   3. Applications are opt-in per org. A closed org rejects submissions, so
--      simply knowing an org id is not enough to write to it.
--   4. Approval is a permission-checked RPC that creates the vendor record, so
--      "approved" and "exists as a vendor" can never drift apart.
--
-- Rate limiting, honeypot, submission timing and Turnstile live in the server
-- action (they need request context the database doesn't have).

create type vendor_application_status as enum (
  'submitted',       -- received, email not yet confirmed
  'email_verified',  -- applicant proved control of the address
  'under_review',
  'approved',
  'rejected',
  'withdrawn'
);

-- Opt-in switch. Off by default: an org must deliberately open the door.
alter table orgs add column if not exists vendor_applications_open boolean not null default false;

create table vendor_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  -- Business identity
  business_name text not null,
  service_category text,
  cac_number text,               -- Corporate Affairs Commission registration
  tin text,                      -- Tax Identification Number
  address text,
  website text,

  -- Contact
  contact_name text not null,
  contact_email text not null,
  contact_phone text,

  notes text,

  status vendor_application_status not null default 'submitted',

  -- Email confirmation. Hash only — the raw token is never stored, same
  -- reasoning as invitations.
  verification_token_hash text,
  email_verified_at timestamptz,

  -- Decision
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_notes text,
  vendor_id uuid references vendors(id),   -- set once approved

  created_at timestamptz not null default now()
);

create index vendor_applications_org_idx on vendor_applications (org_id, status);
create index vendor_applications_email_idx on vendor_applications (org_id, lower(contact_email));
create unique index vendor_applications_verify_uidx
  on vendor_applications (verification_token_hash) where verification_token_hash is not null;

-- Duplicate guard: one live application per business per org. Re-applying while
-- a decision is pending is refused rather than silently queued twice.
create unique index vendor_applications_open_uidx
  on vendor_applications (org_id, lower(business_name))
  where status in ('submitted', 'email_verified', 'under_review');

alter table vendor_applications enable row level security;

-- anon/authenticated may INSERT, and only into an org that has opened
-- applications. Deliberately no SELECT policy for anon: an applicant cannot
-- read back anything, so the table cannot be enumerated or probed.
create policy vendor_applications_public_insert on vendor_applications
  for insert to anon, authenticated
  with check (
    status = 'submitted'
    and exists (
      select 1 from orgs o
      where o.id = org_id and o.vendor_applications_open = true
    )
  );

-- Staff read + decide within their own org.
create policy vendor_applications_staff_select on vendor_applications
  for select to authenticated
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[])
  );

create policy vendor_applications_staff_update on vendor_applications
  for update to authenticated
  using (
    org_id = current_user_org_id()
    and current_user_role() = any (array['admin','facility_manager']::user_role[])
  )
  with check (org_id = current_user_org_id());

create trigger audit_vendor_application_write
  after insert or update on vendor_applications
  for each row execute function log_audit('vendor_application.write');

-- ── Email confirmation (unauthenticated, token-based) ──────────────────────
-- Returns true only when a pending application matched. No information is
-- returned about why a token failed, so it cannot be probed.
create or replace function confirm_vendor_application_email(p_token_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from vendor_applications
  where verification_token_hash = p_token_hash and status = 'submitted';

  if v_id is null then
    return false;
  end if;

  update vendor_applications
  set status = 'email_verified',
      email_verified_at = now(),
      verification_token_hash = null   -- single use
  where id = v_id;

  return true;
end;
$$;

-- ── Approval ───────────────────────────────────────────────────────────────
-- Creates the vendor record as part of approving, so an approved application
-- always has exactly one corresponding vendor and the two cannot drift.
create or replace function approve_vendor_application(p_application_id uuid, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  app vendor_applications%rowtype;
  v_new_vendor uuid;
begin
  select * into app from vendor_applications where id = p_application_id for update;
  if app.id is null then
    raise exception 'application not found';
  end if;
  if app.org_id is distinct from current_user_org_id() then
    raise exception 'application belongs to another organisation';
  end if;
  if current_user_role() not in ('admin', 'facility_manager') then
    raise exception 'only an administrator or FM/PM may approve vendor applications';
  end if;
  if app.status = 'approved' then
    raise exception 'this application is already approved';
  end if;
  if app.status in ('rejected', 'withdrawn') then
    raise exception 'this application was already closed';
  end if;

  insert into vendors (org_id, name, service_category, contact_email, contact_phone,
                       status, approval_status, approved_by, approved_at)
  values (app.org_id, app.business_name, app.service_category, app.contact_email,
          app.contact_phone, 'active', 'approved', auth.uid(), now())
  returning id into v_new_vendor;

  update vendor_applications
  set status = 'approved', decided_by = auth.uid(), decided_at = now(),
      decision_notes = p_notes, vendor_id = v_new_vendor
  where id = p_application_id;

  return v_new_vendor;
end;
$$;

create or replace function reject_vendor_application(p_application_id uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare app vendor_applications%rowtype;
begin
  select * into app from vendor_applications where id = p_application_id for update;
  if app.id is null then raise exception 'application not found'; end if;
  if app.org_id is distinct from current_user_org_id() then
    raise exception 'application belongs to another organisation';
  end if;
  if current_user_role() not in ('admin', 'facility_manager') then
    raise exception 'only an administrator or FM/PM may decide vendor applications';
  end if;
  if app.status in ('approved', 'rejected', 'withdrawn') then
    raise exception 'this application was already closed';
  end if;

  update vendor_applications
  set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes
  where id = p_application_id;
end;
$$;

-- Public page needs the org's name to say who is being applied to, and whether
-- the door is open. Returns nothing for a closed or unknown org.
create or replace function vendor_application_org(p_org_id uuid)
returns table (org_name text, delivery_brand delivery_brand)
language sql security definer stable set search_path = public as $$
  select o.name, o.delivery_brand
  from orgs o
  where o.id = p_org_id and o.vendor_applications_open = true;
$$;

revoke all on function confirm_vendor_application_email(text) from public;
revoke all on function approve_vendor_application(uuid, text) from public;
revoke all on function reject_vendor_application(uuid, text) from public;
revoke all on function vendor_application_org(uuid) from public;

grant execute on function vendor_application_org(uuid) to anon, authenticated;
grant execute on function confirm_vendor_application_email(text) to anon, authenticated;
grant execute on function approve_vendor_application(uuid, text) to authenticated;
grant execute on function reject_vendor_application(uuid, text) to authenticated;
