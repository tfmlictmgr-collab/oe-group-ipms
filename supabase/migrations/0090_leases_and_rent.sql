-- Day 9. Leases, rent billing, and the fee model that turns rent into a
-- landlord statement.
--
-- ⚠️ **Rent in Nigeria is paid annually, in advance.** One or two years up
-- front is ordinary; monthly residential rent is the exception, not the norm.
-- A schema that assumed a monthly cycle — as almost every off-the-shelf PM
-- system does — would model this market wrongly at the root, so `annual` is the
-- default frequency and `paid_in_advance` is true by default. Monthly and
-- quarterly exist for the commercial lettings that do use them.
--
-- Money that has already been received for periods not yet occupied is a
-- LIABILITY, not income. That is what makes the custodial model (locked
-- decision, OEA expansion) correct rather than merely careful: the landlord's
-- share of next year's rent is being held, and the ledger already knows how to
-- say so.

-- ── The fee model (locked decision 14, 1 Aug 2026) ────────────────────────
--
-- Org-wide default plus a per-landlord override, reusing the shape decision 7
-- built for the permission matrix: a baseline, a visible deviation, a reset.
alter table orgs add column if not exists management_fee_pct numeric(6,3)
  not null default 10.000 check (management_fee_pct >= 0 and management_fee_pct <= 100);

-- Deliberately a flat placeholder. Its real shape — an ongoing percentage, or a
-- one-time charge per tenancy — is undecided (decision 14), and inventing one
-- now would bake a guess into every statement produced before the decision.
alter table orgs add column if not exists admin_fee_flat numeric(14,2)
  not null default 0 check (admin_fee_flat >= 0);

comment on column orgs.management_fee_pct is
  'The org-wide default management fee. A landlord may carry a negotiated rate in landlord_terms; whichever applies is SNAPSHOTTED onto the charge, never read live.';

create table landlord_terms (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  landlord_user_id uuid not null references users(id) on delete cascade,

  -- Null means "use the org default". Stored as an explicit override row so the
  -- UI can show a diff from the baseline and offer a one-click reset — the same
  -- affordance the permission matrix already has, rather than a second pattern
  -- invented for money.
  management_fee_pct numeric(6,3) check (management_fee_pct >= 0 and management_fee_pct <= 100),

  agreed_by  uuid references users(id),
  agreed_at  timestamptz not null default now(),
  note       text,

  constraint landlord_terms_one_per_landlord unique (org_id, landlord_user_id)
);

alter table landlord_terms enable row level security;

create policy landlord_terms_select on landlord_terms for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      landlord_user_id = auth.uid()                      -- a landlord sees their own rate
      or current_user_role() = any (oversight_roles())
    )
  );

-- Only finance and admin negotiate a rate. An FM/PM who could set the fee could
-- change what the landlord is paid without touching the ledger.
create policy landlord_terms_write on landlord_terms for all to authenticated
  using (org_id = current_user_org_id()
         and current_user_role() = any (array['admin','finance_approver']::user_role[]))
  with check (org_id = current_user_org_id()
              and current_user_role() = any (array['admin','finance_approver']::user_role[]));

create trigger audit_landlord_terms after insert or update or delete on landlord_terms
  for each row execute function log_audit('landlord_terms.write');

comment on table landlord_terms is
  'A landlord''s negotiated management fee, overriding the org default. Matches how PM fees are actually negotiated in the Nigerian market — a single fixed org-wide rate does not.';

/** The rate that applies to a landlord right now: their own, or the org default. */
create or replace function effective_management_fee_pct(p_org_id uuid, p_landlord uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select t.management_fee_pct from landlord_terms t
      where t.org_id = p_org_id and t.landlord_user_id = p_landlord
        and t.management_fee_pct is not null),
    (select o.management_fee_pct from orgs o where o.id = p_org_id),
    0
  );
$$;

revoke all on function effective_management_fee_pct(uuid, uuid) from public;
grant execute on function effective_management_fee_pct(uuid, uuid) to authenticated, service_role;

-- ── Leases ────────────────────────────────────────────────────────────────
create type rent_frequency as enum ('annual', 'quarterly', 'monthly');
create type lease_status   as enum ('draft', 'active', 'expired', 'terminated', 'renewed');

create table leases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  property_id uuid not null,
  unit_id     uuid not null,
  tenant_user_id uuid references users(id),

  -- Where this tenancy came from, when it came through the portal. Nullable: a
  -- lease can be recorded for a tenant who applied on paper years ago.
  application_id uuid,

  start_date date not null,
  end_date   date not null,
  status     lease_status not null default 'draft',

  rent_amount numeric(14,2) not null check (rent_amount > 0),
  rent_frequency rent_frequency not null default 'annual',
  paid_in_advance boolean not null default true,
  currency text not null default 'NGN',

  -- Applied when the lease renews, never retrospectively.
  escalation_pct numeric(6,3) not null default 0
    check (escalation_pct >= 0 and escalation_pct <= 100),

  deposit_amount numeric(14,2) not null default 0 check (deposit_amount >= 0),

  -- The chain, so a renewed tenancy can be followed back through its history.
  renewed_from_lease_id uuid references leases(id),

  notes text,
  created_by uuid references users(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leases_dates_ordered check (end_date > start_date),
  constraint leases_property_same_org_fk
    foreign key (property_id, org_id) references properties (id, org_id),
  constraint leases_id_org_uniq unique (id, org_id)
);

-- A unit cannot be let twice over the same days. Enforced by the database
-- because a double-let is not a data-entry mistake to be reported later — it is
-- two families holding keys to one flat.
create extension if not exists btree_gist;
alter table leases add constraint leases_no_overlap
  exclude using gist (
    unit_id with =,
    daterange(start_date, end_date, '[)') with &&
  ) where (status in ('active', 'renewed') and deleted_at is null);

create index leases_org_status_idx on leases (org_id, status) where deleted_at is null;
create index leases_unit_idx on leases (unit_id);
create index leases_tenant_idx on leases (tenant_user_id);
create index leases_end_date_idx on leases (end_date) where deleted_at is null;

create trigger leases_touch before update on leases
  for each row execute function touch_updated_at();
create trigger audit_leases after insert or update on leases
  for each row execute function log_audit('leases.write');
create trigger leases_no_hard_delete before delete on leases
  for each row execute function block_hard_delete();
create trigger leases_not_on_operator before insert on leases
  for each row execute function operator_org_holds_no_client_data();

comment on constraint leases_no_overlap on leases is
  'One unit, one active tenancy at a time. A double-let is two families holding keys to one flat, so it is refused by the database rather than caught in a report.';

-- ── What rent is owed ─────────────────────────────────────────────────────
--
-- Separate from `payment_intents`, which is how money is COLLECTED. This is
-- what is OWED — the same split service charges already use, and what lets a
-- demand exist before anyone has tried to pay it.
create type rent_charge_status as enum ('due', 'part_paid', 'paid', 'waived');

create table rent_charges (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references orgs(id) on delete cascade,
  lease_id  uuid not null,

  -- The occupancy this covers. Rent received now for a period not yet occupied
  -- is money held, not money earned.
  period_start date not null,
  period_end   date not null,
  due_date     date not null,

  amount   numeric(14,2) not null check (amount > 0),
  currency text not null default 'NGN',
  status   rent_charge_status not null default 'due',
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),

  -- ⚠️ **Snapshotted, never referenced live** (decision 14). A rate change must
  -- not silently rewrite what a past landlord statement said. These are written
  -- when the charge is raised and are never recalculated.
  management_fee_pct numeric(6,3) not null,
  management_fee_amount numeric(14,2) not null,
  admin_fee_amount numeric(14,2) not null default 0,
  landlord_net_amount numeric(14,2) not null,

  ledger_entry_id uuid references ledger_entries(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rent_charges_period_ordered check (period_end > period_start),
  constraint rent_charges_lease_same_org_fk
    foreign key (lease_id, org_id) references leases (id, org_id) on delete cascade,
  -- One charge per lease per period. A re-run of the billing job must not raise
  -- the same demand twice.
  constraint rent_charges_one_per_period unique (lease_id, period_start)
);

create index rent_charges_org_status_idx on rent_charges (org_id, status);
create index rent_charges_due_idx on rent_charges (due_date) where status <> 'paid';
create index rent_charges_lease_idx on rent_charges (lease_id);

create trigger rent_charges_touch before update on rent_charges
  for each row execute function touch_updated_at();
create trigger audit_rent_charges after insert or update on rent_charges
  for each row execute function log_audit('rent.write');

comment on column rent_charges.management_fee_pct is
  'The rate in force when this charge was raised, snapshotted. Never recalculated: a later rate change must not rewrite a past landlord statement (decision 14).';

-- ── Who may see and write rent ────────────────────────────────────────────
alter table leases enable row level security;
alter table rent_charges enable row level security;

create policy leases_select on leases for select to authenticated
  using (
    org_id = current_user_org_id()
    and deleted_at is null
    and (
      tenant_user_id = auth.uid()                        -- your own tenancy
      or current_user_role() = any (oversight_roles())
      or property_id in (select current_user_property_ids())
    )
  );

create policy leases_write on leases for all to authenticated
  using (
    org_id = current_user_org_id()
    and (select has_permission('leases.write'))
    and (current_user_role() = any (oversight_roles())
         or property_id in (select current_user_property_ids()))
  )
  with check (
    org_id = current_user_org_id()
    and (select has_permission('leases.write'))
    and (current_user_role() = any (oversight_roles())
         or property_id in (select current_user_property_ids()))
  );

create policy rent_charges_select on rent_charges for select to authenticated
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from leases l
       where l.id = rent_charges.lease_id
         and (
           l.tenant_user_id = auth.uid()
           or current_user_role() = any (oversight_roles())
           or l.property_id in (select current_user_property_ids())
         )
    )
  );

-- No write policy for `authenticated`: rent is raised by `raise_rent_charge()`,
-- which snapshots the fee. A hand-written INSERT could set any fee it liked on
-- a charge that then reads as authoritative on a landlord statement.

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('leases.write', 'Lettings', 'Create and manage leases',
   'Record tenancies, set rent and escalation, and end or renew a lease. Changing a lease changes what a tenant owes and what a landlord is paid.',
   false, 48)
on conflict (key) do nothing;

insert into role_permissions (org_id, role, capability, granted)
  select o.id, r.role, 'leases.write',
         r.role in ('admin', 'facility_manager', 'regional_manager')
    from orgs o
    cross join (select unnest(enum_range(null::user_role)) as role) r
on conflict (org_id, role, capability) do nothing;
