-- Org-wide P&L, from the ledger rather than from a summary somebody maintains.
--
-- The chart of accounts has carried `income` and `expense` classes since 0027,
-- and every fee taken at collection posts to 4000 Management & admin fees. What
-- there has never been is a statement of them: the BI dashboard reports
-- requests, vendor scores and budget utilisation, and `ledger_account_balances`
-- gives a position at a moment. Neither answers "what did this organisation
-- earn and spend last quarter".
--
-- ⚠️ PER CURRENCY, never summed across. This is the 0103 lesson, and it is
-- worth restating because a P&L is exactly where it would recur: the
-- segregation view once summed `funds_held` across every currency with no
-- grouping, so the moment a second currency carried a balance it added Naira
-- and Dollars and reported a shortfall that meant nothing — on the one screen
-- whose purpose was catching that. A P&L that totals ₦ and $ into one "profit"
-- figure is the same mistake with a friendlier name. There is no grand total
-- here on purpose; the caller gets a row per currency and must present them
-- apart.

create or replace function org_profit_and_loss(
  p_from date,
  p_to   date
)
returns table (
  currency text,
  class text,
  account_code text,
  account_name text,
  amount numeric,
  posting_count bigint
)
language sql stable security definer set search_path = public as $$
  select
    a.currency,
    a.class::text,
    a.code,
    a.name,
    -- Normalised so both classes read positive, because "expenses: -420,000"
    -- on a statement is a sign convention the reader has to decode. Income is
    -- credited (negative postings) and expense debited (positive), so income
    -- flips and expense does not — the same rule `ledger_account_balances`
    -- already applies as `natural_balance`, stated here rather than joined to
    -- that view so the date filter can reach the postings.
    case when a.class = 'income' then -sum(p.amount) else sum(p.amount) end::numeric,
    count(p.id)
  from ledger_accounts a
  join ledger_postings p on p.account_id = a.id
  join ledger_entries e  on e.id = p.entry_id
  where a.class in ('income', 'expense')
    and e.entry_date >= p_from
    and e.entry_date <= p_to
    -- The whole boundary. SECURITY DEFINER, so this clause is all that stands
    -- between a caller and every organisation's books.
    and a.org_id = current_user_org_id()
    and current_user_role() = any (oversight_roles())
  group by a.currency, a.class, a.code, a.name
  -- An account with postings that net to zero over the period is still a fact
  -- about the period, so it is NOT filtered out: "we billed and refunded the
  -- same amount" and "we did nothing" are different statements.
  order by a.currency, a.class desc, a.code;
$$;

revoke all on function org_profit_and_loss(date, date) from public;
revoke execute on function org_profit_and_loss(date, date) from anon;
grant execute on function org_profit_and_loss(date, date) to authenticated;

comment on function org_profit_and_loss is
  'Income and expense by account over a period, for the caller''s own org, grouped BY CURRENCY and never summed across it -- the 0103 lesson, where a cross-currency sum on the segregation view reported a shortfall that meant nothing. Amounts are normalised so both classes read positive. Definer-scoped to current_user_org_id() and to oversight_roles().';

-- ── The statement a landlord is owed ──────────────────────────────────────
--
-- "Generate reports (org-wide P&L and STATEMENTS)". The P&L is the org's own
-- position; a landlord statement is what OE Group owes a specific owner and
-- how it got there — collected, fees taken, remitted, still held. That figure
-- exists today only as an aggregate on the ledger, so a landlord asking "what
-- happened to my January rent" could not be answered from a screen.
create or replace function landlord_statement(
  p_landlord_user_id uuid,
  p_from date,
  p_to   date
)
returns table (
  property_id uuid,
  property_name text,
  charges bigint,
  demanded numeric,
  collected numeric,
  fees numeric,
  landlord_share numeric,
  remitted numeric,
  still_held numeric
)
language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.name,
    count(rc.id),
    coalesce(sum(rc.amount), 0)::numeric,
    coalesce(sum(rc.amount_paid), 0)::numeric,
    -- The fee actually taken, apportioned to what was collected. Read from the
    -- rate SNAPSHOTTED on the charge (decision 14), never recomputed from the
    -- org's current rate — a later rate change must not silently rewrite a
    -- past statement, which is the entire reason the snapshot exists.
    coalesce(sum(round(
      (rc.management_fee_amount + rc.admin_fee_amount) * (rc.amount_paid / nullif(rc.amount, 0)), 2
    )), 0)::numeric,
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0)::numeric,
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
      filter (where rc.remitted_at is not null), 0)::numeric,
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
      filter (where rc.remitted_at is null), 0)::numeric
  from properties p
  join leases l      on l.property_id = p.id and l.deleted_at is null
  join rent_charges rc on rc.lease_id = l.id
  where p.org_id = current_user_org_id()
    and rc.period_start >= p_from
    and rc.period_start <= p_to
    and exists (
      select 1 from property_stakeholders s
       where s.property_id = p.id and s.relation = 'owner'
         and s.user_id = p_landlord_user_id
    )
    -- A landlord may pull their OWN statement; oversight may pull anyone's.
    -- Without the first clause this is a finance-only report, and the owner —
    -- whose money it is — would have to ask for it by email.
    and (
      p_landlord_user_id = auth.uid()
      or current_user_role() = any (oversight_roles())
    )
  group by p.id, p.name
  order by p.name;
$$;

revoke all on function landlord_statement(uuid, date, date) from public;
revoke execute on function landlord_statement(uuid, date, date) from anon;
grant execute on function landlord_statement(uuid, date, date) to authenticated;

comment on function landlord_statement is
  'What was demanded, collected, taken in fees, remitted and still held for one landlord over a period, per property. Fees come from the rate snapshotted on each charge (decision 14) -- never recomputed, so a rate change cannot rewrite a past statement. Callable by the landlord themselves or by oversight.';
