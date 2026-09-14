-- Two statements about one building, disagreeing about what happened on it.
--
-- `property_statement` (0228) answers "show me this property": rent demanded,
-- collected, fees, the landlord's share, remitted, held — AND, kept
-- deliberately apart, the service charge billed and collected. `landlord_statement`
-- (0130) answers "show me what I am owed", per property, for one owner — and
-- has only ever carried the rent half.
--
-- So a landlord opening `/dashboard/portfolio` and a manager opening the same
-- building's statement were shown different accounts of the same property. The
-- landlord's own screen was the one missing a column, on money billed to units
-- in a building they own. Nobody had written a rule saying an owner should not
-- see the service charge; it simply was not there, because `landlord_statement`
-- was written during the finance build before `sc_budgets` had a per-property
-- report to join to.
--
-- 📌 This is the shape recorded three times already in decision 24: a consumer
-- written when there was one case, still correct for that case, silently
-- incomplete once a second arrived. The second case here is the service charge,
-- and `property_statement` is the reader that got it. Adding the second case is
-- finished when every reader of the first has been re-read.
--
-- ⚠️ RENT AND SERVICE CHARGE ARE STILL NEVER ADDED, and this migration adds no
-- column that would let a caller do it by accident. Rent is collected FOR the
-- landlord and remitted to them net of fees; service charge is collected INTO a
-- fund the property spends on itself. A combined total is the 0103 mistake with
-- a friendlier label. `property_statement` refuses the same sum for the same
-- reason and the portfolio screen renders them as two cards, not one table.
--
-- The SC join is copied from `property_statement` deliberately — through
-- `sc_budgets.property_id`, never `service_charges.unit_id`, because the unit
-- column is nullable on rows written before 0003 added it and a statement that
-- silently omits charges is worse than one that says nothing. Two reports about
-- one building must agree on what a service charge IS, and the only way to be
-- sure of that is to define it once and read it the same way twice.
--
-- Everything about the rent half is unchanged, down to the arithmetic: fees and
-- the landlord's share stay apportioned to what was actually COLLECTED, off the
-- rate snapshotted on the charge (decision 14). A rate change must not rewrite
-- a past statement, and that is why this touches none of it.
--
-- The return type gains columns, so the function is dropped and recreated
-- rather than replaced. `/dashboard/portfolio` is its only caller.

drop function if exists landlord_statement(uuid, date, date);

create or replace function landlord_statement(
  p_landlord_user_id uuid,
  p_from date,
  p_to   date
)
returns table (
  property_id uuid,
  property_name text,
  currency text,
  charges bigint,
  demanded numeric,
  collected numeric,
  fees numeric,
  landlord_share numeric,
  remitted numeric,
  still_held numeric,
  -- New (0230). The fund's side of the same building, never added to the above.
  sc_invoices bigint,
  sc_billed numeric,
  sc_collected numeric,
  sc_outstanding numeric
)
language sql stable security definer set search_path = public as $$
  with allowed as (
    -- The whole boundary, unchanged from 0130: the properties this landlord
    -- owns, and only if the caller is that landlord or oversight. SECURITY
    -- DEFINER, so this is all that stands between a caller and every owner's
    -- books.
    select p.id, p.name
      from properties p
     where p.org_id = current_user_org_id()
       and exists (
         select 1 from property_stakeholders s
          where s.property_id = p.id
            and s.relation = 'owner'
            and s.user_id = p_landlord_user_id
       )
       and (
         p_landlord_user_id = auth.uid()
         or current_user_role() = any (oversight_roles())
       )
  ),
  rent as (
    select
      a.id as pid,
      count(rc.id) as n,
      coalesce(sum(rc.amount), 0) as demanded,
      coalesce(sum(rc.amount_paid), 0) as collected,
      coalesce(sum(round(
        (rc.management_fee_amount + rc.admin_fee_amount)
        * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) as fees,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) as net,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
        filter (where rc.remitted_at is not null), 0) as remitted,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
        filter (where rc.remitted_at is null), 0) as held,
      -- The property's own currency, read off its charges rather than assumed.
      -- `orgs` carries no default_currency (checked, not guessed), so 'NGN' is
      -- the fallback and the commonest wins if a building ever carries two —
      -- reporting the commonest is wrong in a way a reader can see, whereas
      -- adding them is wrong in a way they cannot (0103).
      coalesce(mode() within group (order by rc.currency), 'NGN') as ccy
    from allowed a
    left join leases l       on l.property_id = a.id and l.deleted_at is null
    left join rent_charges rc on rc.lease_id = l.id
                            and rc.period_start >= p_from
                            and rc.period_start <= p_to
    group by a.id
  ),
  sc as (
    select
      a.id as pid,
      count(s.id) as n,
      coalesce(sum(s.amount), 0) as billed,
      coalesce(sum(s.amount_paid), 0) as collected
    from allowed a
    left join sc_budgets b on b.property_id = a.id
    left join service_charges s on s.budget_id = b.id
                              and s.deleted_at is null
                              and s.created_at::date >= p_from
                              and s.created_at::date <= p_to
    group by a.id
  )
  select
    a.id, a.name, rent.ccy,
    rent.n, rent.demanded, rent.collected, rent.fees, rent.net, rent.remitted, rent.held,
    sc.n, sc.billed, sc.collected, greatest(sc.billed - sc.collected, 0)
  from allowed a
  join rent on rent.pid = a.id
  join sc   on sc.pid = a.id
  order by a.name;
$$;

revoke all on function landlord_statement(uuid, date, date) from public;
revoke execute on function landlord_statement(uuid, date, date) from anon;
grant execute on function landlord_statement(uuid, date, date) to authenticated;

comment on function landlord_statement is
  'What was demanded, collected, taken in fees, remitted and still held for one landlord over a period, per property -- and, kept deliberately separate and never added to it, the service charge billed and collected on the same building (0230). Fees come from the rate snapshotted on each charge (decision 14), never recomputed, so a rate change cannot rewrite a past statement. The service-charge join goes through sc_budgets.property_id, the same rule property_statement uses, so the two reports about one building cannot disagree. Callable by the landlord themselves or by oversight.';
