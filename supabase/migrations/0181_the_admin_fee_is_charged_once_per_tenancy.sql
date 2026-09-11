-- Decision 14 left the admin fee's SHAPE open — "ongoing % vs one-time
-- per-tenancy charge" — and the column `orgs.admin_fee_flat` stood as a flat
-- placeholder until someone chose. The choice is now made: **one-time, per
-- tenancy** (3 Aug 2026 direction, minuted here).
--
-- ⚠️ What "placeholder" never meant. `raise_rent_charge` has deducted
-- `admin_fee_flat` from EVERY rent demand since Day 9 — the code was fully
-- wired the whole time, and only the decision was pending. On an annual
-- cadence (decision 15) that is the fee charged again every single year of a
-- tenancy, against a decision that says once. No live row was ever affected
-- (`admin_fee_amount > 0` matches zero rent_charges on every world), which is
-- the only reason this is a change rather than a correction with restitution
-- attached.
--
-- ── Configurable, not constant ────────────────────────────────────────────
-- Asked whether this could be set per case from the dashboard rather than in
-- code, and it can — the same answer decision 15 gave for notice periods and
-- decision 14 gave for the management fee. A commercial letting and a
-- residential one legitimately differ, and a rule compiled into a function is
-- a rule nobody can adjust at 4pm on a Friday.
--
--   • `orgs.admin_fee_basis`   — the organisation's default
--   • `leases.admin_fee_basis` — NULL means "follow the org"; set means this
--                                tenancy departs from it, deliberately
--
-- That is decision 14's own pattern — a default with a visible per-case
-- override — reused rather than reinvented for the second fee in the same
-- statement.
--
-- ── What "per tenancy" means, exactly ─────────────────────────────────────
-- A renewal is the SAME tenancy continuing, not a new letting: `renew_lease`
-- closes one term and opens the next, linked by `renewed_from_lease_id`. So
-- the fee lands on the first demand of the tenancy and never again, however
-- many terms follow. An organisation that genuinely re-charges on renewal
-- sets `per_demand`, which is honest about what it does — the fee then
-- applies to every demand, which is what that setting has always meant.
--
-- The chain is walked UPWARDS from the lease being billed. A renewal can only
-- ever be created after the term it replaces, so any earlier charge in the
-- tenancy is on an ancestor; there is no need to search downwards, and doing
-- so would make the answer depend on rows that do not exist yet.
create type admin_fee_basis as enum ('per_tenancy', 'per_demand');

alter table orgs add column if not exists admin_fee_basis admin_fee_basis
  not null default 'per_tenancy';

alter table leases add column if not exists admin_fee_basis admin_fee_basis;

comment on column orgs.admin_fee_basis is
  'How the flat admin fee is applied: per_tenancy (once, on the first demand of a tenancy — the default and decision 14''s resolution) or per_demand (every demand). Set in Settings → Lettings.';

comment on column leases.admin_fee_basis is
  'This tenancy''s departure from the org default. NULL means follow the org, which is what almost every lease should say.';

comment on column orgs.admin_fee_flat is
  'The flat admin fee AMOUNT. How often it is charged is admin_fee_basis, not this column. Snapshotted onto rent_charges.admin_fee_amount when a demand is raised, and never referenced live thereafter (decision 14).';

-- Settings → Lettings writes this through the administrator's own session, so
-- it must be on 0083c's UPDATE allowlist. 0102 and 0159 both exist because a
-- column was added without this line; that is three times now.
grant update (admin_fee_basis) on orgs to authenticated;

-- ── The tenancy a lease belongs to ────────────────────────────────────────
--
-- Every lease in the chain, this one included, oldest last. Named as a concept
-- rather than inlined as a CTE because "which leases are the same tenancy" is
-- a question the rent roll and the landlord statement will both ask eventually,
-- and two spellings of it would drift.
create or replace function lease_tenancy_chain(p_lease_id uuid)
returns table (lease_id uuid)
language sql stable security definer set search_path = public as $$
  with recursive chain as (
    select l.id, l.renewed_from_lease_id
      from leases l
     where l.id = p_lease_id
    union all
    select prior.id, prior.renewed_from_lease_id
      from leases prior
      join chain c on prior.id = c.renewed_from_lease_id
  )
  select id from chain;
$$;

revoke all on function lease_tenancy_chain(uuid) from public;
grant execute on function lease_tenancy_chain(uuid) to authenticated, service_role;

comment on function lease_tenancy_chain is
  'The leases forming one tenancy: this term and every term it renewed from. Walks upwards only — a renewal is always created after the term it replaces.';

-- ── The one write path, with the fee applied once ─────────────────────────
--
-- Everything else here is unchanged from 0091: same guards, same order, same
-- freezing of the split onto the row. Only the admin-fee line moved.
create or replace function raise_rent_charge(
  p_lease_id     uuid,
  p_period_start date,
  p_period_end   date,
  p_due_date     date default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  l          leases%rowtype;
  v_landlord uuid;
  v_pct      numeric;
  v_admin    numeric;
  v_basis    admin_fee_basis;
  v_mgmt_amt numeric;
  v_id       uuid;
begin
  select * into l from leases where id = p_lease_id and deleted_at is null;
  if l.id is null then
    raise exception 'that lease could not be found';
  end if;
  if auth.uid() is not null then
    if l.org_id is distinct from current_user_org_id() then
      raise exception 'that lease belongs to another organisation';
    end if;
    if not has_permission('leases.write') then
      raise exception 'you do not have permission to bill rent';
    end if;
  end if;
  if l.status not in ('active', 'renewed') then
    raise exception 'rent can only be billed on an active lease — this one is %', l.status;
  end if;
  if p_period_end <= p_period_start then
    raise exception 'the period must end after it starts';
  end if;

  -- The landlord is the property's owner. Their negotiated rate, or the org
  -- default — resolved ONCE, here, and then frozen onto the row.
  select s.user_id into v_landlord
    from property_stakeholders s
   where s.property_id = l.property_id and s.relation = 'owner'
   limit 1;

  v_pct := effective_management_fee_pct(l.org_id, v_landlord);

  select o.admin_fee_flat, coalesce(l.admin_fee_basis, o.admin_fee_basis)
    into v_admin, v_basis
    from orgs o where o.id = l.org_id;

  -- Charged once per tenancy: if any term of this tenancy has already been
  -- billed, the fee has already been taken.
  if v_basis = 'per_tenancy' and exists (
       select 1 from rent_charges rc
        where rc.lease_id in (select lease_id from lease_tenancy_chain(l.id))
     ) then
    v_admin := 0;
  end if;

  v_mgmt_amt := round(l.rent_amount * v_pct / 100.0, 2);

  insert into rent_charges (
    org_id, lease_id, period_start, period_end, due_date,
    amount, currency,
    management_fee_pct, management_fee_amount, admin_fee_amount, landlord_net_amount
  ) values (
    l.org_id, l.id, p_period_start, p_period_end,
    coalesce(p_due_date, p_period_start),
    l.rent_amount, l.currency,
    v_pct, v_mgmt_amt, coalesce(v_admin, 0),
    l.rent_amount - v_mgmt_amt - coalesce(v_admin, 0)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function raise_rent_charge(uuid, date, date, date) from public;
grant execute on function raise_rent_charge(uuid, date, date, date) to authenticated, service_role;

comment on function raise_rent_charge is
  'Raises a rent demand and FREEZES the fee split onto it. The only write path into rent_charges — a hand-written insert could claim any fee and the landlord statement would repeat it. The admin fee is applied per the lease''s, or failing that the org''s, admin_fee_basis (0181).';
