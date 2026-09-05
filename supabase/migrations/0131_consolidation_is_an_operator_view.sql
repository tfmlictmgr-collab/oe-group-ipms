-- Multi-entity consolidation.
--
-- ⚠️ This is a B1 crossing, and it is the reason this file is careful. "A user
-- on one portal must never see the other brand's data or existence" — and a
-- consolidated P&L is, by definition, one figure built from several orgs'
-- books. There is exactly one party entitled to that: **the platform operator**,
-- OE Group itself, which owns both brands and the client relationships.
--
-- So it is built where decision 7 already put the single deliberate crossing:
-- behind `caller_is_operator_admin()`, on the operator portal, never as a
-- cross-org RLS policy and never on a brand's own finance page. A TFML finance
-- lead does not get a "consolidated" tab that quietly includes OEA.
--
-- Three choices worth stating, because each could reasonably have gone the
-- other way:
--
-- 1. **Per-org rows, not one merged total.** The operator is entitled to both,
--    and rows they can sum themselves are strictly more useful than a total
--    they cannot decompose. A single number would also hide the case that
--    matters most — one entity carrying another.
--
-- 2. **The gate is INSIDE the query**, so a brand administrator who reaches the
--    endpoint gets an EMPTY SET rather than a refusal. Same reasoning as
--    `operator_org_directory()` (decision 12): a refusal confirms there is
--    something worth refusing, and here that something is the existence of the
--    other orgs.
--
-- 3. **Not written to `operator_actions`.** That table records deliberate
--    interventions — provisioning, suspension, break-glass — each with a
--    reason of at least ten characters, and its own comment says it exists "so
--    the crossings can be listed on their own without filtering a million
--    rows". An audit row per page load would drown exactly the signal it was
--    built to preserve. This is a read of aggregates by the party that owns
--    them, gated the same way the org directory is. If the board later wants
--    operator reporting reads recorded, that is a new action type and a
--    deliberate decision, not something to slip in here.
--
-- ⚠️ And a limit worth stating plainly rather than papering over: **no org
-- currently has a `parent_org_id`.** All five are flat. The column exists from
-- Step 2 for exactly this purpose, and nothing has ever populated it. So
-- "consolidation" today means "every live org the operator governs", grouped by
-- delivery brand — which is the useful answer for OE Group's actual shape (TFML,
-- OEA, direct clients) and does not pretend to a hierarchy that has not been
-- configured. When parents are set, `parent_org_id` is the grouping to add; the
-- shape below does not have to change to accommodate it.

create or replace function operator_consolidated_position(
  p_from date,
  p_to   date
)
returns table (
  org_id uuid,
  org_name text,
  org_slug text,
  delivery_brand text,
  currency text,
  income numeric,
  expense numeric,
  net numeric,
  funds_held numeric,
  funds_owed numeric
)
language sql stable security definer set search_path = public as $$
  with pl as (
    select
      a.org_id,
      a.currency,
      sum(case when a.class = 'income'  then -p.amount else 0 end) as income,
      sum(case when a.class = 'expense' then  p.amount else 0 end) as expense
    from ledger_accounts a
    join ledger_postings p on p.account_id = a.id
    join ledger_entries e  on e.id = p.entry_id
    where a.class in ('income', 'expense')
      and e.entry_date >= p_from
      and e.entry_date <= p_to
    group by a.org_id, a.currency
  ),
  held as (
    -- The segregation position, per org per currency. Deliberately NOT date
    -- filtered: what is held is a position now, not a flow over a period, and
    -- showing "funds held during Q1" would invite reading a balance as a total.
    select
      b.org_id,
      b.currency,
      sum(b.natural_balance) filter (where b.purpose = 'client_funds') as funds_held,
      sum(b.natural_balance) filter (
        where b.class = 'liability'
          and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
      ) as funds_owed
    from ledger_account_balances b
    group by b.org_id, b.currency
  )
  select
    o.id, o.name, o.slug, o.delivery_brand,
    coalesce(pl.currency, held.currency, 'NGN'),
    coalesce(pl.income, 0)::numeric,
    coalesce(pl.expense, 0)::numeric,
    (coalesce(pl.income, 0) - coalesce(pl.expense, 0))::numeric,
    coalesce(held.funds_held, 0)::numeric,
    coalesce(held.funds_owed, 0)::numeric
  from orgs o
  left join pl   on pl.org_id = o.id
  left join held on held.org_id = o.id and held.currency = coalesce(pl.currency, 'NGN')
  where o.deleted_at is null
    -- The operator org is excluded from its own consolidation. It is the holder
    -- of the view, not an entity within it, and including it would double-count
    -- nothing but confuse everything.
    and not o.is_platform_operator
    -- The whole boundary, inside the query. A brand administrator who reaches
    -- this gets zero rows, not an error.
    and (select caller_is_operator_admin())
  order by o.delivery_brand, o.name;
$$;

revoke all on function operator_consolidated_position(date, date) from public;
revoke execute on function operator_consolidated_position(date, date) from anon;
grant execute on function operator_consolidated_position(date, date) to authenticated;

comment on function operator_consolidated_position is
  'Income, expense and the client-funds position for every live client org, per currency, for the platform operator only. Gated INSIDE the query on caller_is_operator_admin() so a brand admin receives an empty set rather than a refusal -- a refusal would confirm the other orgs exist (decision 12). Per-org rows rather than one merged total, and never summed across currencies. Groups by delivery_brand because no org has a parent_org_id set; when parents are configured that becomes the grouping to add.';
