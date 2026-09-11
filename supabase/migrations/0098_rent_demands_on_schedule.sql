-- Rent demands raised on a schedule, not by hand.
--
-- `orgs.rent_demand_lead_days` has been stored and configurable since `0093` and
-- read by nothing. Demands were raised by clicking "Bill rent" on the rent roll,
-- which works until the day nobody clicks it — and with rent billed **annually
-- in advance** (locked decision 15), the day nobody clicks it is a year's rent
-- that never got asked for.
--
-- ⚠️ This function DECIDES nothing about money. It answers "which lease is due
-- for its next demand, and for what period", and the caller passes that to
-- `raise_rent_charge()`, which is still the only thing that writes a charge and
-- still snapshots the fee. A second path into rent_charges is exactly what
-- `0092` exists to prevent.

/**
 * How long one billing period runs, by frequency.
 *
 * Explicit rather than derived from the enum's order, for the same reason
 * `hierarchy_depth()` is: adding a frequency later must be a considered change
 * here, not something that silently re-dates every future demand.
 */
create or replace function rent_period_length(p_freq rent_frequency)
returns interval language sql immutable as $$
  select case p_freq
           when 'annual'    then interval '1 year'
           when 'quarterly' then interval '3 months'
           when 'monthly'   then interval '1 month'
         end;
$$;

/**
 * Leases whose next rent period should be demanded now.
 *
 * The next period starts where the last raised charge ended, or at the lease's
 * own start when nothing has been billed yet — so a lease recorded mid-term
 * bills from its start rather than from today, and a gap can never open between
 * periods.
 *
 * Returned only when BOTH hold:
 *   • the lead time has been reached — `today >= period_start - lead_days`
 *   • the period actually begins inside the lease term
 *
 * The second is what stops a tenancy billing past its own end. Without it the
 * final demand of every lease would be followed by one more, for a year the
 * tenant has not agreed to occupy.
 */
create or replace function leases_needing_rent_demand(p_org_id uuid)
returns table (
  lease_id uuid,
  property_name text,
  unit_label text,
  tenant_user_id uuid,
  period_start date,
  period_end date,
  rent_amount numeric,
  lead_days integer
)
language sql stable security definer set search_path = public as $$
  with next_period as (
    select
      l.id,
      p.name  as property_name,
      u.label as unit_label,
      l.tenant_user_id,
      l.rent_amount,
      o.rent_demand_lead_days,
      l.end_date,
      -- Where the next period begins: after the latest one already raised, or
      -- at the lease start if this is the first.
      coalesce(
        (select max(rc.period_end) from rent_charges rc where rc.lease_id = l.id),
        l.start_date
      ) as starts,
      rent_period_length(l.rent_frequency) as len
    from leases l
    join properties p on p.id = l.property_id
    join units u      on u.id = l.unit_id
    join orgs o       on o.id = l.org_id
    where l.org_id = p_org_id
      and l.deleted_at is null
      and l.status in ('active', 'renewed')
  )
  select
    id, property_name, unit_label, tenant_user_id,
    starts::date,
    (starts + len)::date,
    rent_amount,
    rent_demand_lead_days
  from next_period
  where starts < end_date                                    -- inside the term
    and current_date >= (starts - make_interval(days => rent_demand_lead_days))::date;
$$;

revoke all on function leases_needing_rent_demand(uuid) from public;
grant execute on function leases_needing_rent_demand(uuid) to authenticated, service_role;

comment on function leases_needing_rent_demand is
  'Leases due for their next rent demand, given the org''s lead time. Reports only — `raise_rent_charge()` remains the sole writer, so the fee snapshot has one code path. A period beginning on or after the lease end is excluded: the last demand of a tenancy must not be followed by one more.';

comment on function rent_period_length is
  'The length of one billing period. Explicit per frequency so adding one later is a considered change rather than a silent re-dating of every future demand.';
