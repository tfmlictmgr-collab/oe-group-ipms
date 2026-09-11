-- Raising rent, renewing a lease, and the rent roll a landlord is handed.

-- ── Raising a charge ──────────────────────────────────────────────────────
--
-- The ONLY way rent is billed. It exists because the fee split has to be
-- computed and frozen at the moment the demand is raised — a hand-written
-- INSERT could put any figure in `management_fee_pct` and the resulting
-- landlord statement would read as authoritative.
create or replace function raise_rent_charge(
  p_lease_id     uuid,
  p_period_start date,
  p_period_end   date,
  p_due_date     date default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  l         leases%rowtype;
  v_landlord uuid;
  v_pct     numeric;
  v_admin   numeric;
  v_mgmt_amt numeric;
  v_id      uuid;
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
  select admin_fee_flat into v_admin from orgs where id = l.org_id;

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
  'Raises a rent demand and FREEZES the fee split onto it. The only write path into rent_charges — a hand-written insert could claim any fee and the landlord statement would repeat it.';

-- ── Activating and renewing ───────────────────────────────────────────────
create or replace function activate_lease(p_lease_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  l leases%rowtype;
begin
  select * into l from leases where id = p_lease_id and deleted_at is null;
  if l.id is null then raise exception 'that lease could not be found'; end if;
  if auth.uid() is not null then
    if l.org_id is distinct from current_user_org_id() then
      raise exception 'that lease belongs to another organisation';
    end if;
    if not has_permission('leases.write') then
      raise exception 'you do not have permission to activate a lease';
    end if;
  end if;
  if l.status <> 'draft' then
    raise exception 'only a draft lease can be activated — this one is %', l.status;
  end if;

  -- The unit's occupant follows the lease. Occupancy and tenancy disagreeing is
  -- how a tenant ends up unable to see their own statement.
  update leases set status = 'active' where id = p_lease_id;
  if l.tenant_user_id is not null then
    update units set occupant_user_id = l.tenant_user_id
     where id = l.unit_id and org_id = l.org_id;
  end if;
end;
$$;

revoke all on function activate_lease(uuid) from public;
grant execute on function activate_lease(uuid) to authenticated, service_role;

/**
 * Renews a lease into a new term, applying the escalation.
 *
 * The escalation is applied HERE and never to the existing row: a rent increase
 * belongs to the new term, and rewriting the old one would change what the
 * tenant was billed for a period they have already paid.
 */
create or replace function renew_lease(
  p_lease_id uuid,
  p_months   integer default 12
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  l      leases%rowtype;
  v_new  uuid;
  v_rent numeric;
begin
  select * into l from leases where id = p_lease_id and deleted_at is null;
  if l.id is null then raise exception 'that lease could not be found'; end if;
  if auth.uid() is not null then
    if l.org_id is distinct from current_user_org_id() then
      raise exception 'that lease belongs to another organisation';
    end if;
    if not has_permission('leases.write') then
      raise exception 'you do not have permission to renew a lease';
    end if;
  end if;
  if l.status not in ('active', 'expired') then
    raise exception 'only an active or expired lease can be renewed — this one is %', l.status;
  end if;
  if p_months < 1 then
    raise exception 'a renewal runs for at least one month';
  end if;

  v_rent := round(l.rent_amount * (1 + l.escalation_pct / 100.0), 2);

  -- The old term closes the day the new one opens, so the exclusion constraint
  -- sees no overlap and the unit is never let twice.
  update leases set status = 'renewed' where id = p_lease_id;

  insert into leases (
    org_id, property_id, unit_id, tenant_user_id, application_id,
    start_date, end_date, status,
    rent_amount, rent_frequency, paid_in_advance, currency,
    escalation_pct, deposit_amount, renewed_from_lease_id, created_by
  ) values (
    l.org_id, l.property_id, l.unit_id, l.tenant_user_id, l.application_id,
    l.end_date, (l.end_date + make_interval(months => p_months))::date, 'active',
    v_rent, l.rent_frequency, l.paid_in_advance, l.currency,
    l.escalation_pct, l.deposit_amount, l.id, auth.uid()
  )
  returning id into v_new;

  return v_new;
end;
$$;

revoke all on function renew_lease(uuid, integer) from public;
grant execute on function renew_lease(uuid, integer) to authenticated, service_role;

comment on function renew_lease is
  'Closes a term and opens the next with the escalation applied. The increase lands on the NEW term — rewriting the old one would change what a tenant was billed for a period already paid.';

-- ── The rent roll ─────────────────────────────────────────────────────────
--
-- The tenancy schedule a landlord is actually handed: who is in which unit,
-- until when, for how much, and what has been collected against it.
--
-- security_invoker, so the caller's own policies decide which rows appear — a
-- landlord sees their portfolio, an FM/PM sees their properties, and nobody
-- needs a second scoping rule written for this view.
create or replace view rent_roll
with (security_invoker = on) as
  select
    l.id                as lease_id,
    l.org_id,
    l.property_id,
    p.name              as property_name,
    l.unit_id,
    u.label             as unit_label,
    l.tenant_user_id,
    t.full_name         as tenant_name,
    t.email             as tenant_email,
    l.status,
    l.start_date,
    l.end_date,
    (l.end_date - current_date)              as days_to_expiry,
    l.rent_amount,
    l.rent_frequency,
    l.escalation_pct,
    l.currency,
    coalesce(c.billed, 0)                    as rent_billed,
    coalesce(c.collected, 0)                 as rent_collected,
    coalesce(c.billed, 0) - coalesce(c.collected, 0) as rent_outstanding,
    coalesce(c.mgmt_fees, 0)                 as management_fees,
    coalesce(c.admin_fees, 0)                as admin_fees,
    coalesce(c.landlord_net, 0)              as landlord_net
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  left join lateral (
    select
      sum(rc.amount)                as billed,
      sum(rc.amount_paid)           as collected,
      sum(rc.management_fee_amount) as mgmt_fees,
      sum(rc.admin_fee_amount)      as admin_fees,
      sum(rc.landlord_net_amount)   as landlord_net
    from rent_charges rc
    where rc.lease_id = l.id
  ) c on true
  where l.deleted_at is null;

comment on view rent_roll is
  'The tenancy schedule: who is in which unit, until when, for how much, and what has been collected. security_invoker — a landlord sees their portfolio and an FM/PM their properties, with no scoping rule written twice.';

grant select on rent_roll to authenticated;

-- ── Leases that are running out ───────────────────────────────────────────
--
-- The board asked for renewal notices at 90/60/30 days. The lead times are org
-- configuration rather than a constant, because a commercial portfolio gives six
-- months' notice where a residential one gives one.
alter table orgs add column if not exists renewal_notice_days integer[]
  not null default '{90,60,30}';

comment on column orgs.renewal_notice_days is
  'Lead times, in days before expiry, at which a renewal notice is sent. Board default 90/60/30; a commercial portfolio may want longer.';

/**
 * Leases crossing a notice threshold today.
 *
 * Returns only leases whose remaining days EQUAL one of the configured lead
 * times, so a daily run sends each notice exactly once. A `<=` test would
 * re-send every day from the threshold to expiry.
 */
create or replace function leases_due_for_notice(p_org_id uuid)
returns table (
  lease_id uuid,
  tenant_user_id uuid,
  tenant_name text,
  tenant_email text,
  property_name text,
  unit_label text,
  end_date date,
  days_remaining integer,
  rent_amount numeric,
  proposed_rent numeric
)
language sql stable security definer set search_path = public as $$
  select
    l.id, l.tenant_user_id, t.full_name, t.email,
    p.name, u.label, l.end_date,
    (l.end_date - current_date)::integer,
    l.rent_amount,
    round(l.rent_amount * (1 + l.escalation_pct / 100.0), 2)
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  join orgs o       on o.id = l.org_id
  where l.org_id = p_org_id
    and l.deleted_at is null
    and l.status = 'active'
    and (l.end_date - current_date)::integer = any (o.renewal_notice_days);
$$;

revoke all on function leases_due_for_notice(uuid) from public;
grant execute on function leases_due_for_notice(uuid) to authenticated, service_role;

comment on function leases_due_for_notice is
  'Leases whose remaining days EQUAL a configured lead time, so a daily run notifies once per threshold. A <= test would re-send every day until expiry.';
