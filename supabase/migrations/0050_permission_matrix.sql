-- Day 6.5 — the permission matrix.
--
-- Role privileges stop being role names written into policies and become data an
-- administrator toggles. But NOT every privilege, and NOT by every administrator.
-- Both limits are the point, and both are enforced here rather than in the UI.
--
-- See CLAUDE.md locked scope decision 7 (v3.2) and PHASE1_WORKPLAN Day 6.5.

-- ── The platform operator ──────────────────────────────────────────────────
--
-- Explicit, not inferred from `delivery_brand = 'direct'`. That field says who
-- DELIVERS the service; this says who GOVERNS the platform. A future
-- direct-delivery client would otherwise silently inherit the right to rewrite
-- every other org's permissions.
alter table orgs add column if not exists is_platform_operator boolean not null default false;

comment on column orgs.is_platform_operator is
  'True for OE Group only. Grants the right to edit OTHER orgs permission matrices — the single deliberate crossing of org isolation, routed through set_role_permission().';

-- At most one. Two operators is not a configuration, it is a mistake.
create unique index if not exists orgs_single_operator_uidx
  on orgs ((true)) where is_platform_operator;

-- ── The catalogue ──────────────────────────────────────────────────────────
--
-- Every capability the system recognises. `locked` capabilities are listed here
-- so they can be SHOWN as locked with their reason — an administrator should see
-- that the boundary exists rather than wonder why a switch is missing — but they
-- are never read by any policy. Their enforcement stays hardwired.
create table capabilities (
  key           text primary key,
  module        text not null,
  label         text not null,
  description   text not null,
  locked        boolean not null default false,
  /** Why it cannot be delegated. Shown on the locked row. */
  locked_reason text,
  sort_order    int not null default 0,
  constraint locked_needs_a_reason check (not locked or locked_reason is not null)
);

alter table capabilities enable row level security;
create policy capabilities_select on capabilities for select using (auth.uid() is not null);
-- No write policy: the catalogue is defined by migration, not by users.

insert into capabilities (key, module, label, description, locked, locked_reason, sort_order) values
  -- Requests
  ('tickets.read_all',      'Requests', 'See all requests',      'Read every service request in the organisation, not only their own.', false, null, 10),
  ('tickets.assign',        'Requests', 'Dispatch requests',     'Assign a request to a vendor or a member of staff.',                  false, null, 11),
  ('tickets.close',         'Requests', 'Close requests',        'Mark a request resolved or closed.',                                  false, null, 12),
  -- Assets
  ('assets.read',           'Assets',   'View the register',     'Read the asset register for properties they can reach.',              false, null, 20),
  ('assets.write',          'Assets',   'Add and edit assets',   'Create and amend assets on properties they manage.',                  false, null, 21),
  ('assets.import',         'Assets',   'Bulk import assets',    'Upload a spreadsheet of assets.',                                     false, null, 22),
  -- Vendors
  ('vendors.read',          'Vendors',  'View vendors',          'Read the vendor list and their details.',                             false, null, 30),
  ('vendors.write',         'Vendors',  'Manage vendors',        'Create and amend vendor records.',                                    false, null, 31),
  ('vendors.evaluate',      'Vendors',  'Score vendors',         'Submit performance evaluations that feed the payment gate.',          false, null, 32),
  -- Service charge
  ('sc.read_all',           'Service charge', 'See all charges', 'Read every service charge, not only their own.',                      false, null, 40),
  ('sc.manage',             'Service charge', 'Budgets and invoicing', 'Create budgets and generate per-unit invoices.',                false, null, 41),
  -- Portfolio
  ('properties.read_all',   'Portfolio', 'See all properties',   'Read every property, not only those they are attached to.',           false, null, 50),
  ('properties.write',      'Portfolio', 'Manage properties',    'Create and amend properties and units.',                              false, null, 51),
  ('units.assign_occupant', 'Portfolio', 'Assign occupants',     'Set which tenant occupies a unit.',                                   false, null, 52),
  -- People
  ('people.invite',         'People',   'Invite people',         'Issue invitations to join the organisation.',                         false, null, 60),
  ('people.deactivate',     'People',   'Deactivate members',    'Remove a person''s access.',                                          false, null, 61),
  -- Reporting
  ('bi.read',               'Reporting','Analytics dashboard',   'Read the executive dashboard and KPI reporting.',                     false, null, 70),

  -- ── Locked. Shown, never toggled. ───────────────────────────────────────
  ('payment.approve', 'Money', 'Approve payments', 'Approve a vendor invoice for payment.', true,
   'Approval is the control an auditor checks. It stays with finance and administrators, and above the configured threshold with administrators only.', 80),
  ('payment.remit',   'Money', 'Send payments',    'Execute a transfer to a vendor or landlord.', true,
   'This moves real money out of the client-funds account.', 81),
  ('ledger.read',     'Money', 'View the ledger',  'Read the client-funds ledger and its balances.', true,
   'These are client funds. Visibility stays with finance and administrators.', 82),
  ('ledger.write',    'Money', 'Post to the ledger', 'Write ledger entries directly.', true,
   'Nobody has this. The ledger is written only by collections and remittance, so every entry has a traceable cause.', 83),
  ('bank.configure',  'Money', 'Configure banking', 'Set the client-funds bank account and opening balance.', true,
   'This defines what reconciliation compares against. Administrators only, separately from the finance staff who reconcile.', 84),
  ('audit.read',      'Governance', 'View the audit trail', 'Read the immutable activity and approval history.', true,
   'The trail must not be readable by everyone it records.', 85),
  ('permissions.edit','Governance', 'Edit permissions', 'Change this matrix.', true,
   'Only the OE Group operator portal. A permission system whose own switch is a permission can be unlocked from inside.', 86),
  ('invitation.create_admin', 'Governance', 'Invite administrators', 'Issue an invitation with the administrator role.', true,
   'Prevents privilege escalation by invitation — an FM/PM cannot mint an administrator.', 87),
  ('channel.credentials', 'Governance', 'Channel credentials', 'Read or set inbound WhatsApp/Telegram routing secrets.', true,
   'These are webhook credentials; holding one lets someone forge service requests into the organisation.', 88);

-- ── The matrix ─────────────────────────────────────────────────────────────
create table role_permissions (
  org_id     uuid not null references orgs(id) on delete cascade,
  role       user_role not null,
  capability text not null references capabilities(key),
  granted    boolean not null,
  -- Who last moved it, and when. Governance evidence, not decoration.
  set_by     uuid references users(id),
  set_at     timestamptz not null default now(),
  primary key (org_id, role, capability)
);

create index role_permissions_lookup_idx on role_permissions (org_id, role, capability);

alter table role_permissions enable row level security;

-- Everyone in an org may READ their org's matrix. Transparency without control:
-- a TFML administrator can see exactly what their staff may reach, and cannot
-- change it.
create policy role_permissions_select on role_permissions for select
  using (org_id = current_user_org_id());

-- No INSERT/UPDATE/DELETE policy at all. The only way to change a row is
-- set_role_permission(), which checks operator status and writes an audit
-- record. A table-level policy would be a second door.

-- ── The B7 baseline ────────────────────────────────────────────────────────
--
-- Seeds a new org from the board-approved matrix. A capability is granted ONLY
-- where B7 explicitly names the role; where B7 is silent the row is written as
-- granted = false rather than left absent, so the matrix always states its
-- position rather than defaulting by omission.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer']::user_role[]
    loop
      v_granted := case
        -- Admin holds every configurable capability. The locked ones are not
        -- in this loop, so this is not a back door.
        when r = 'admin' then true

        when cap.key = 'tickets.read_all' then r in ('facility_manager','finance_approver')
        when cap.key = 'tickets.assign'   then r = 'facility_manager'
        when cap.key = 'tickets.close'    then r in ('facility_manager','fm_ops_staff')

        when cap.key = 'assets.read'      then r in ('facility_manager','finance_approver','property_owner')
        when cap.key = 'assets.write'     then r = 'facility_manager'
        when cap.key = 'assets.import'    then r = 'facility_manager'

        when cap.key = 'vendors.read'     then r in ('facility_manager','finance_approver')
        when cap.key = 'vendors.write'    then r = 'facility_manager'
        when cap.key = 'vendors.evaluate' then r = 'facility_manager'

        when cap.key = 'sc.read_all'      then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'        then r = 'finance_approver'

        when cap.key = 'properties.read_all'   then r = 'finance_approver'
        when cap.key = 'properties.write'      then r = 'facility_manager'
        when cap.key = 'units.assign_occupant' then r = 'facility_manager'

        when cap.key = 'people.invite'     then r = 'facility_manager'
        when cap.key = 'people.deactivate' then false   -- B7: admin only

        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')

        -- B7 is silent → OFF. A new org starts locked down and is opened
        -- deliberately.
        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

revoke all on function seed_b7_permissions(uuid) from public;
grant execute on function seed_b7_permissions(uuid) to service_role;

-- ── The resolver ───────────────────────────────────────────────────────────
--
-- Used by RLS, so it must be cheap and must never error. An unknown capability,
-- a missing row, a user with no profile — all resolve to DENIED. Failing open
-- here would silently widen access for exactly the cases nobody tested.
create or replace function has_permission(p_capability text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select rp.granted
       from role_permissions rp
      where rp.org_id = current_user_org_id()
        and rp.role = current_user_role()
        and rp.capability = p_capability),
    false
  );
$$;

comment on function has_permission(text) is
  'Whether the CURRENT user''s role holds a capability in their own org. Denies on anything unknown or absent — a permission check that fails open is not a permission check.';

grant execute on function has_permission(text) to authenticated, service_role;

-- ── Changing it: operator only, always audited ─────────────────────────────
--
-- The one deliberate crossing of org isolation in this system. It is a FUNCTION
-- rather than a cross-org RLS policy on purpose: a policy would leave the
-- boundary permanently weakened for every query, whereas this leaves it intact
-- with a single guarded door that records who went through it.
create or replace function set_role_permission(
  p_org_id uuid,
  p_role user_role,
  p_capability text,
  p_granted boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_is_operator boolean;
  v_locked boolean;
  v_target_name text;
begin
  select locked into v_locked from capabilities where key = p_capability;
  if v_locked is null then
    raise exception 'unknown capability %', p_capability;
  end if;
  if v_locked then
    raise exception
      'capability % is not delegable and cannot be granted or revoked', p_capability;
  end if;

  -- The service role (auth.uid() is null) is allowed through for seeding.
  if v_caller is not null then
    select o.is_platform_operator into v_is_operator
      from orgs o where o.id = current_user_org_id();

    if not coalesce(v_is_operator, false) then
      raise exception 'permissions are set on the OE Group operator portal, not here';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator of the operator organisation may change permissions';
    end if;
  end if;

  select name into v_target_name from orgs where id = p_org_id;
  if v_target_name is null then
    raise exception 'that organisation could not be found';
  end if;

  insert into role_permissions (org_id, role, capability, granted, set_by, set_at)
  values (p_org_id, p_role, p_capability, p_granted, v_caller, now())
  on conflict (org_id, role, capability)
    do update set granted = excluded.granted, set_by = excluded.set_by, set_at = now();

  -- Named on BOTH sides: whose matrix changed, and who changed it. A cross-org
  -- write that only records the target tells you nothing about the crossing.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    p_org_id, v_caller, 'permission.set', 'role_permission', p_org_id,
    jsonb_build_object(
      'role', p_role, 'capability', p_capability, 'granted', p_granted,
      'target_org', v_target_name,
      'by_org', (select name from orgs where id = current_user_org_id())
    )
  );
end;
$$;

revoke all on function set_role_permission(uuid, user_role, text, boolean) from public;
grant execute on function set_role_permission(uuid, user_role, text, boolean)
  to authenticated, service_role;

-- Seed every existing org from B7.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;
