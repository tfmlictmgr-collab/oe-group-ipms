-- A property has one owner of record, and both money paths ask the same
-- question to find them.
--
-- `property_stakeholders` is unique on `(property_id, user_id, relation)`, so
-- nothing has ever stopped two different people both holding
-- `relation = 'owner'` on one property. Two money paths read that set, and both
-- read it wrongly, in opposite directions:
--
--   1. **`raise_rent_charge` picks arbitrarily.** `0091` wrote
--      `select s.user_id into v_landlord … limit 1` with **no `order by`**, and
--      `0181` carried the same three lines forward unchanged. The chosen id is
--      then passed to `effective_management_fee_pct()`, whose answer —
--      per decision 14, the landlord's negotiated rate or the org default — is
--      **snapshotted onto the row and never referenced live again**. So on a
--      co-owned property, which rate is frozen onto a rent charge forever is
--      decided by the query planner. Nothing would ever look wrong; the
--      statement would simply be built on the other owner's rate.
--
--   2. **`landlord_payout_candidates` counts once per owner.** It groups by
--      `owner.user_id` while the `rent_charges` join is not filtered per owner,
--      so each owner's row reports the **whole** collected-and-unremitted sum.
--      Finance reads a liability of 2x what is held and is offered the same
--      money against two people.
--
--      ⚠️ Stated precisely, because the difference matters: the second SEND is
--      already refused. `create_rent_remittance` locks the charges
--      `for update`, claims them `where remitted_at is null`, and aborts if the
--      count it claims differs from the count it locked. So this is a false
--      liability on a screen and an offer that cannot be taken twice — not an
--      executed double payment. It is being fixed because a payout list that
--      overstates what is held is how a real one gets approved.
--
-- **`property_landlord()` is the one question, asked once.** Decision 8's rule
-- — one resolver, extended, never a second — applied to ownership. Ordered by
-- `created_at` then `user_id`: the first owner recorded, tie-broken by a value
-- that cannot change, so the answer is stable across calls, across sessions and
-- across a restore.
--
-- ⚠️ What this deliberately does NOT do. It does not invent split ownership.
-- `property_stakeholders` has no share column, `create_rent_remittance` pays
-- against a PROPERTY rather than a share, and inventing a split here would put
-- a number nobody agreed into the one place decision 14 says is permanent.
-- A co-owner who is not the owner of record is now consistently excluded rather
-- than inconsistently double-counted, which is a fixed and visible position
-- instead of a random one. Representing genuine co-ownership needs a board
-- decision, not a migration.

create or replace function property_landlord(p_property_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select s.user_id
    from property_stakeholders s
   where s.property_id = p_property_id
     and s.relation = 'owner'
   order by s.created_at, s.user_id
   limit 1;
$$;

revoke all on function property_landlord(uuid) from public;
revoke execute on function property_landlord(uuid) from anon;
grant execute on function property_landlord(uuid) to authenticated, service_role;

comment on function property_landlord is
  'The owner of record of a property: the first person recorded with relation = owner, tie-broken by user id so the answer never moves. The single place rent billing and landlord payout both ask who the landlord is -- they asked separately before 0232, and disagreed, one arbitrarily and one by double-counting. Not a share model: co-ownership has no representation in property_stakeholders and is not invented here.';

-- ---------------------------------------------------------------------------
-- The fee snapshot now asks the resolver
-- ---------------------------------------------------------------------------

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

  -- The owner of record, resolved once and then frozen onto the row. Was an
  -- unordered `limit 1` from 0091 through 0181 (0232).
  v_landlord := property_landlord(l.property_id);

  v_pct := effective_management_fee_pct(l.org_id, v_landlord);

  select o.admin_fee_flat, coalesce(l.admin_fee_basis, o.admin_fee_basis)
    into v_admin, v_basis
    from orgs o where o.id = l.org_id;

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
revoke execute on function raise_rent_charge(uuid, date, date, date) from anon;
grant execute on function raise_rent_charge(uuid, date, date, date) to authenticated, service_role;

comment on function raise_rent_charge is
  'Raises a rent demand and FREEZES the fee split onto it. The only write path into rent_charges -- a hand-written insert could claim any fee and the landlord statement would repeat it. The admin fee is applied per the lease''s, or failing that the org''s, admin_fee_basis (0181). The landlord comes from property_landlord(), so which co-owner''s negotiated rate is frozen is no longer the planner''s choice (0232).';

-- ---------------------------------------------------------------------------
-- The payout list offers each property once
-- ---------------------------------------------------------------------------

create or replace function landlord_payout_candidates()
returns table (
  property_id uuid,
  property_name text,
  landlord_user_id uuid,
  landlord_name text,
  collected numeric,
  charge_count bigint,
  has_recipient boolean
)
language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.name,
    u.id,
    coalesce(u.full_name, u.email),
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0)::numeric,
    count(rc.id),
    exists (
      select 1 from payout_recipients pr
       where pr.org_id = p.org_id
         and pr.party = 'landlord'
         and pr.user_id = u.id
         and pr.active
         and pr.recipient_code is not null
    )
  from properties p
  -- One owner per property, from the resolver -- not a join to every row in
  -- property_stakeholders, which fanned the rent out once per co-owner (0232).
  join users u on u.id = property_landlord(p.id)
  join leases l on l.property_id = p.id and l.deleted_at is null
  join rent_charges rc
    on rc.lease_id = l.id
   and rc.amount_paid > 0        -- collected, not merely demanded
   and rc.remitted_at is null    -- and not already paid out
  where p.org_id = current_user_org_id()
    and p.deleted_at is null
    and current_user_role() = any (array['admin','finance_approver','executive']::user_role[])
  group by p.id, p.name, u.id, u.full_name, u.email
  having coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) > 0
  order by 5 desc;
$$;

revoke all on function landlord_payout_candidates() from public;
revoke execute on function landlord_payout_candidates() from anon;
grant execute on function landlord_payout_candidates() to authenticated;

comment on function landlord_payout_candidates is
  'Properties holding rent that has been COLLECTED and not yet remitted, with the owner of record, the landlord''s net share of what was actually paid, and whether they have a verified bank recipient. One row per property: the owner comes from property_landlord(), where joining property_stakeholders directly reported the whole sum once per co-owner (0232). Totals the same expression create_rent_remittance uses, now with the same nullif guard, so a charge of zero cannot divide by zero. Definer-scoped to the caller''s org AND to finance/admin/executive -- an executive may look, and is refused the send in the database.';
