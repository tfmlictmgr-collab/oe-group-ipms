-- 📌 9 Oct 2026. The money-in and money-out reports say which rows are test records.
--
-- 0321 marks walkthrough records that money touched as test data. The two
-- activity reports from 0318 return no record ids, so the screen could not tell a
-- test collection from a real one. Each row now carries `is_test`, read from
-- `test_records` in the caller's own session, so the Reports screen can leave
-- test rows out by default and label them when asked. A function's return type
-- cannot change in place, so both are dropped and created again; the bodies are
-- 0318's with the one column added, and the grants are restated in full.

drop function if exists report_collections(date, date);
drop function if exists report_payouts(date, date);

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
  reference text,
  is_test boolean
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
    x.gateway_reference,
    exists (select 1 from test_records t where t.entity_type = 'payment_intent' and t.entity_id = x.id)
  from paid x
  left join properties pr on pr.id = x.prop_id
  left join units un on un.id = x.unit_id
  left join users pu on pu.id = x.payer_user_id
  order by 1, 4 nulls last, 2;
$$;

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
  bank_reference text,
  is_test boolean
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
    r.transfer_code,
    exists (select 1 from test_records t where t.entity_type = 'remittance' and t.entity_id = r.id)
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

revoke all on function report_collections(date, date) from public, anon, authenticated, service_role;
revoke all on function report_payouts(date, date) from public, anon, authenticated, service_role;
grant execute on function report_collections(date, date) to authenticated;
grant execute on function report_payouts(date, date) to authenticated;

do $$
declare bad text; n int;
begin
  select string_agg(routine_name || '→' || grantee, ', ') into bad
    from information_schema.routine_privileges
   where routine_schema = 'public' and routine_name in ('report_collections', 'report_payouts')
     and grantee in ('PUBLIC', 'anon', 'service_role');
  if bad is not null then raise exception 'report functions over-granted: %', bad; end if;
  select count(*) into n from pg_proc where proname in ('report_collections', 'report_payouts') and prosecdef;
  if n > 0 then raise exception 'report functions must run as the caller'; end if;
end $$;
