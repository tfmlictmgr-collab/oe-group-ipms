-- 📌 9 Oct 2026. Reports the head of accounts can actually run.
--
-- Asked after the production walkthrough: "I don't see how the head of accounts
-- (the Payment Approver) can generate reports by property, tenant, landlord,
-- type of payment … and the journal didn't show the difference (deficit /
-- surplus) after the vendor was paid." Measured: Client Funds → Reports was the
-- organisation's profit and loss for a period and nothing else, and the Journal
-- listed each entry's movements with no balance after them, so the one fact the
-- walkthrough needed — that Akpabio 01's fund was left at −₦183.35 — was
-- visible only by adding up postings by hand.
--
-- Five read paths, one rule: every one is SECURITY INVOKER, so it returns
-- exactly what the caller's own read policies already admit (decision 8: no
-- second scoping mechanism). The Payment Approver is in `oversight_roles()`
-- (0157/0246) and reads the whole organisation; a property or regional manager
-- reads their own places; a tenant reaching a report function directly gets
-- their own payments and nothing else, because that is what
-- `payment_intents_select` already says. None of them can widen anything.
--
--   • ledger_posting_balances — every posting with the account's balance AFTER
--     it, in its natural sign. The Journal and the per-account page both read
--     it, so the two can never disagree about a running balance.
--   • report_collections(from, to) — money in, one row per payment: when, by
--     which channel (Paystack, Flutterwave, bank transfer confirmed by three
--     desks), for what (rent, service charge…), on which property and unit,
--     from whom, whose building, and the fee and landlord net as POSTED (read
--     from the ledger entry the collection made, never recomputed).
--   • report_payouts(from, to) — money out: what kind (vendor invoice,
--     requisition, landlord), to whom, against which property, by which route,
--     gross, fees, net, the bank or gateway reference.
--   • report_property_funds(from, to) — each building's service-charge fund:
--     opening, collected, spent, closing, and whether it is overdrawn.
--   • report_trial_balance(as_at) — every account's debits, credits and balance.
--
-- Rent and service charge are never added together, and neither are
-- currencies: every row carries its currency and the screen totals per
-- currency (decision 25, 0103).

-- ── Running balances ───────────────────────────────────────────────────────
create or replace view ledger_posting_balances with (security_invoker = on) as
  select
    p.id as posting_id,
    p.entry_id,
    p.account_id,
    p.org_id,
    p.amount,
    (case when a.class in ('asset', 'expense') then p.amount else -p.amount end)::numeric(16,2) as natural_amount,
    (sum(case when a.class in ('asset', 'expense') then p.amount else -p.amount end)
       over (partition by p.account_id
             order by e.created_at, e.id, p.id
             rows between unbounded preceding and current row))::numeric(16,2) as balance_after,
    e.entry_date,
    e.created_at as entry_created_at
  from ledger_postings p
  join ledger_entries e on e.id = p.entry_id
  join ledger_accounts a on a.id = p.account_id;

comment on view ledger_posting_balances is
  'Each posting with its account''s balance after it, in the account''s natural sign (negative on a liability = overdrawn). security_invoker: rows are what the caller''s ledger policies admit. 0318.';

revoke all on table ledger_posting_balances from public, anon;
grant select on table ledger_posting_balances to authenticated;

-- ── Money in ───────────────────────────────────────────────────────────────
create or replace function report_collections(p_from date, p_to date)
returns table (
  paid_on date,
  channel text,
  purpose text,
  property text,
  unit text,
  payer text,
  landlord text,
  currency text,
  amount numeric,
  management_fee numeric,
  landlord_net numeric,
  reference text
)
language sql stable security invoker set search_path = public
as $$
  with paid as (
    select
      i.*,
      coalesce(
        i.property_id,
        (select l.property_id from rent_charges rc join leases l on l.id = rc.lease_id where rc.id = i.rent_charge_id),
        (select b.property_id from service_charges sc join sc_budgets b on b.id = sc.budget_id where sc.id = i.service_charge_id)
      ) as prop_id
    from payment_intents i
    where i.status = 'paid'
      and (coalesce(i.paid_at, i.updated_at) at time zone 'Africa/Lagos')::date between p_from and p_to
  )
  select
    (coalesce(x.paid_at, x.updated_at) at time zone 'Africa/Lagos')::date,
    case x.gateway::text
      when 'paystack' then 'Paystack'
      when 'flutterwave' then 'Flutterwave'
      when 'manual' then 'Bank transfer (confirmed)'
      when 'simulated' then 'Simulated (test)'
      else initcap(x.gateway::text)
    end,
    case x.purpose::text
      when 'service_charge' then 'Service charge'
      when 'rent' then 'Rent'
      when 'deposit' then 'Deposit'
      else initcap(replace(x.purpose::text, '_', ' '))
    end,
    pr.name,
    un.label,
    coalesce(pu.full_name, x.payer_email),
    (select string_agg(ou.full_name, ', ' order by ou.full_name)
       from property_stakeholders ps join users ou on ou.id = ps.user_id
      where ps.property_id = x.prop_id and ps.relation = 'owner'),
    x.currency,
    x.amount_paid,
    -- As posted, from the collection's own ledger entry: the fee at the rate
    -- frozen on the demand and the landlord's share, never recomputed here.
    (select -sum(p.amount) from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where p.entry_id = x.ledger_entry_id and a.purpose = 'fee_income'),
    (select -sum(p.amount) from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where p.entry_id = x.ledger_entry_id and a.purpose = 'landlord_payable'),
    x.gateway_reference
  from paid x
  left join properties pr on pr.id = x.prop_id
  left join units un on un.id = x.unit_id
  left join users pu on pu.id = x.payer_user_id
  order by 1, 4 nulls last, 2;
$$;

-- ── Money out ──────────────────────────────────────────────────────────────
create or replace function report_payouts(p_from date, p_to date)
returns table (
  paid_on date,
  kind text,
  payee text,
  property text,
  channel text,
  currency text,
  gross numeric,
  fees numeric,
  net numeric,
  reference text,
  bank_reference text
)
language sql stable security invoker set search_path = public
as $$
  select
    (coalesce(r.sent_at, r.created_at) at time zone 'Africa/Lagos')::date,
    case
      when r.requisition_id is not null then 'Requisition'
      when r.party::text = 'vendor' then 'Vendor invoice'
      when r.party::text = 'landlord' then 'Landlord payout'
      else initcap(r.party::text)
    end,
    coalesce(rec.display_name, v.name),
    pr.name,
    case r.gateway::text
      when 'paystack' then 'Paystack transfer'
      when 'manual' then 'Bank transfer (recorded)'
      else initcap(r.gateway::text)
    end,
    r.currency,
    r.gross_amount,
    coalesce(r.management_fee, 0) + coalesce(r.admin_fee, 0),
    r.net_amount,
    r.reference,
    r.transfer_code
  from remittances r
  left join payout_recipients rec on rec.id = r.recipient_id
  left join payments pay on pay.id = r.payment_id
  left join vendors v on v.id = coalesce(rec.vendor_id, pay.vendor_id)
  left join properties pr on pr.id = coalesce(
    r.property_id,
    (select t.property_id from tickets t where t.id = pay.ticket_id)
  )
  where r.status::text in ('sent', 'settled')
    and (coalesce(r.sent_at, r.created_at) at time zone 'Africa/Lagos')::date between p_from and p_to
  order by 1, 2;
$$;

-- ── Each building's fund ───────────────────────────────────────────────────
create or replace function report_property_funds(p_from date, p_to date)
returns table (
  account_id uuid,
  code text,
  property text,
  currency text,
  opening numeric,
  collected numeric,
  spent numeric,
  closing numeric,
  overdrawn boolean
)
language sql stable security invoker set search_path = public
as $$
  select
    a.id,
    a.code,
    coalesce(pr.name, 'Not attached to a property'),
    a.currency,
    coalesce(sum(b.natural_amount) filter (where b.entry_date < p_from), 0),
    coalesce(sum(b.natural_amount) filter (where b.entry_date between p_from and p_to and b.natural_amount > 0), 0),
    coalesce(-sum(b.natural_amount) filter (where b.entry_date between p_from and p_to and b.natural_amount < 0), 0),
    coalesce(sum(b.natural_amount) filter (where b.entry_date <= p_to), 0),
    coalesce(sum(b.natural_amount) filter (where b.entry_date <= p_to), 0) < 0
  from ledger_accounts a
  left join properties pr on pr.id = a.property_id
  left join ledger_posting_balances b on b.account_id = a.id
  where a.purpose = 'service_charge_fund'
  group by a.id, a.code, pr.name, a.currency
  order by a.currency, a.code;
$$;

-- ── Trial balance ──────────────────────────────────────────────────────────
create or replace function report_trial_balance(p_as_at date)
returns table (
  account_id uuid,
  code text,
  name text,
  class text,
  currency text,
  debits numeric,
  credits numeric,
  balance numeric
)
language sql stable security invoker set search_path = public
as $$
  select
    a.id,
    a.code,
    a.name,
    a.class::text,
    a.currency,
    coalesce(sum(b.amount) filter (where b.amount > 0 and b.entry_date <= p_as_at), 0),
    coalesce(-sum(b.amount) filter (where b.amount < 0 and b.entry_date <= p_as_at), 0),
    coalesce(sum(b.natural_amount) filter (where b.entry_date <= p_as_at), 0)
  from ledger_accounts a
  left join ledger_posting_balances b on b.account_id = a.id
  group by a.id, a.code, a.name, a.class, a.currency
  order by a.currency, a.code;
$$;

-- ── Grants, stated in full ─────────────────────────────────────────────────
revoke all on function report_collections(date, date) from public, anon, authenticated, service_role;
revoke all on function report_payouts(date, date) from public, anon, authenticated, service_role;
revoke all on function report_property_funds(date, date) from public, anon, authenticated, service_role;
revoke all on function report_trial_balance(date) from public, anon, authenticated, service_role;

grant execute on function report_collections(date, date) to authenticated;
grant execute on function report_payouts(date, date) to authenticated;
grant execute on function report_property_funds(date, date) to authenticated;
grant execute on function report_trial_balance(date) to authenticated;

-- ── Assertions ─────────────────────────────────────────────────────────────
do $$
declare bad text; n int;
begin
  select string_agg(routine_name || '→' || grantee, ', ') into bad
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('report_collections', 'report_payouts', 'report_property_funds', 'report_trial_balance')
     and grantee in ('PUBLIC', 'anon', 'service_role');
  if bad is not null then raise exception 'report functions over-granted: %', bad; end if;

  -- Invoker, all of them: a definer report would read past the caller's policies.
  select count(*) into n from pg_proc
   where proname in ('report_collections', 'report_payouts', 'report_property_funds', 'report_trial_balance')
     and prosecdef;
  if n > 0 then raise exception '% report function(s) are SECURITY DEFINER; they must run as the caller', n; end if;

  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'ledger_posting_balances' and grantee in ('anon', 'PUBLIC')) then
    raise exception 'ledger_posting_balances is readable by anon';
  end if;

  -- The running balance ends where the account balance is, for every account.
  select count(*) into n
    from ledger_account_balances lab
    left join lateral (
      select balance_after from ledger_posting_balances b
       where b.account_id = lab.account_id
       order by b.entry_created_at desc, b.entry_id desc, b.posting_id desc limit 1
    ) last on true
   where coalesce(last.balance_after, 0) <> lab.natural_balance;
  if n > 0 then raise exception 'ledger_posting_balances disagrees with ledger_account_balances on % account(s)', n; end if;
end $$;
