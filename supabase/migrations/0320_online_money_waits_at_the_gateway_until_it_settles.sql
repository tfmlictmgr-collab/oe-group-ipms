-- 📌 9 Oct 2026. Online money is booked where it actually is.
--
-- Asked directly after the walkthrough: online payments were "booked as in the
-- bank the moment the gateway confirms them, though they sit with Paystack until
-- settlement and arrive net of fees". Measured on production: two Paystack
-- collections (₦16.65 and ₦1,000) posted to 1000 Client funds (bank) on 8 Oct,
-- while the money was in OEA's Paystack balance and would reach Fidelity a day
-- later, less Paystack's fee. The ledger and the bank statement could not agree
-- on the day, and nothing anywhere recorded the fee.
--
-- The model, one account per gateway per currency (purpose `gateway_clearing`,
-- 0319), mirroring that gateway's balance:
--
--   collection (online)   Dr <Gateway> balance        Cr landlord / fund / fee
--   settlement            Dr Bank (net) + Bank charges (fee)   Cr <Gateway> balance (gross)
--   Paystack payout       Dr payable                   Cr Paystack balance
--   top-up of Paystack    Dr Paystack balance          Cr Bank
--
-- So the gateway account should equal what the gateway's dashboard shows, and
-- the bank account what the bank statement shows — each reconcilable on its own.
-- Money at the gateway is still client money: it counts as HELD in the
-- segregation position (`funds_held`), and is stated separately as
-- `funds_at_gateway`.
--
-- A bank transfer (offline, 0281) and the simulated test gateway still post to
-- the bank: there is no gateway in between.
--
-- 📌 Four movements are added because finance had no way to record them at all.
-- The reconciliation journey has always said "post a correcting entry with a
-- stated reason (a bank fee, for example)", and no screen or function let any
-- person do it. Each is narrow, not a free-form journal: a gateway settlement, a
-- top-up of the gateway balance, a bank charge, and funding an overdrawn account
-- from the organisation's own money (the remedy decision 63's −₦183.35 needs).
-- Each is SECURITY DEFINER, refuses anyone but the Payment Officer or the Payment
-- Approver, and writes an ordinary balanced ledger entry — immutable, audited by
-- the existing `audit_ledger_entry` trigger, reversible only by a reversal.
--
-- History is left where it was posted. Collections made before this migration
-- stay on the bank account; their gateway fee is recorded as a bank charge when
-- the settlement shows it.

-- ── 1. The gateway balance account, opened on first use ────────────────────
create or replace function ensure_gateway_clearing_account(p_org_id uuid, p_gateway text, p_currency text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_gateway text := lower(trim(p_gateway));
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_code text;
begin
  if v_gateway not in ('paystack', 'flutterwave') then
    raise exception 'unknown gateway %', p_gateway;
  end if;
  select id into v_id from ledger_accounts
   where org_id = p_org_id and purpose = 'gateway_clearing' and gateway = v_gateway and currency = v_currency
   order by created_at limit 1;
  if v_id is not null then return v_id; end if;

  v_code := case v_gateway when 'paystack' then '1010' else '1020' end
            || case when v_currency <> 'NGN' then '-' || v_currency else '' end;
  if exists (select 1 from ledger_accounts where org_id = p_org_id and lower(code) = lower(v_code)) then
    raise exception 'account code % is already taken in this organisation; the % balance account cannot be opened', v_code, initcap(v_gateway);
  end if;

  insert into ledger_accounts (org_id, code, name, class, purpose, gateway, currency, active)
  values (p_org_id, v_code,
          initcap(v_gateway) || ' balance (not yet settled)' || case when v_currency <> 'NGN' then ' — ' || v_currency else '' end,
          'asset', 'gateway_clearing', v_gateway, v_currency, true)
  returning id into v_id;
  return v_id;
end;
$$;

-- ── 2. Collections and Paystack payouts post to the gateway balance ────────
do $$
declare
  d text; old_acl text;
  o constant text := $o$  v_bank := collection_bank_account(intent.org_id, intent.currency);$o$;
  n constant text := $n$  -- 0320: an online payment sits at the gateway until it settles; only a
  -- bank transfer (manual) or the simulated test gateway reaches the bank directly.
  v_bank := case
    when intent.gateway::text in ('paystack', 'flutterwave')
      then ensure_gateway_clearing_account(intent.org_id, intent.gateway::text, intent.currency)
    else collection_bank_account(intent.org_id, intent.currency)
  end;$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.record_collection(uuid, numeric, timestamp with time zone)'::regprocedure;
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, replace(o, E'\r', ''), ''))) / length(replace(o, E'\r', '')) <> 1 then
    raise exception 'record_collection: expected the bank resolution exactly once';
  end if;
  execute replace(d, replace(o, E'\r', ''), replace(n, E'\r', ''));
  if (select p.proacl::text from pg_proc p where p.oid = 'public.record_collection(uuid, numeric, timestamp with time zone)'::regprocedure) is distinct from old_acl then
    raise exception 'record_collection: grants changed by the rebuild';
  end if;
end $$;

do $$
declare
  d text; old_acl text;
  o1 constant text := $o$  v_bank := bank.ledger_account_id;$o$;
  n1 constant text := $n$  -- 0320: a Paystack transfer is paid from the Paystack balance, not the bank.
  v_bank := case
    when r.gateway::text = 'paystack' then ensure_gateway_clearing_account(r.org_id, 'paystack', r.currency)
    else bank.ledger_account_id
  end;$n$;
  o2 constant text := $o$case when r.gateway = 'manual' then 'Paid by bank transfer from ' else 'Paid via ' || r.gateway || ' from ' end || bank.label$o$;
  n2 constant text := $n$case when r.gateway::text = 'manual' then 'Paid by bank transfer from ' || bank.label
               when r.gateway::text = 'paystack' then 'Paid by Paystack transfer from the Paystack balance'
               else 'Paid via ' || r.gateway || ' from ' || bank.label end$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.record_remittance_sent(uuid, text, timestamp with time zone)'::regprocedure;
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, replace(o1, E'\r', ''), ''))) / length(replace(o1, E'\r', '')) <> 1 then
    raise exception 'record_remittance_sent: expected the bank account exactly once';
  end if;
  if (length(d) - length(replace(d, replace(o2, E'\r', ''), ''))) / length(replace(o2, E'\r', '')) <> 1 then
    raise exception 'record_remittance_sent: expected the memo exactly once';
  end if;
  execute replace(replace(d, replace(o1, E'\r', ''), replace(n1, E'\r', '')), replace(o2, E'\r', ''), replace(n2, E'\r', ''));
  if (select p.proacl::text from pg_proc p where p.oid = 'public.record_remittance_sent(uuid, text, timestamp with time zone)'::regprocedure) is distinct from old_acl then
    raise exception 'record_remittance_sent: grants changed by the rebuild';
  end if;
end $$;

-- ── 3. Money at the gateway is held client money ───────────────────────────
create or replace view client_funds_position with (security_invoker = on) as
  select
    b.org_id,
    sum(b.natural_balance) filter (where b.purpose in ('client_funds', 'gateway_clearing')) as funds_held,
    sum(greatest(b.natural_balance, 0)) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
    ) as funds_owed,
    (
      coalesce(sum(b.natural_balance) filter (where b.purpose in ('client_funds', 'gateway_clearing')), 0)
      - coalesce(sum(greatest(b.natural_balance, 0)) filter (
          where b.class = 'liability'
            and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
        ), 0)
    )::numeric(16,2) as unallocated,
    b.currency,
    coalesce(sum(greatest(-b.natural_balance, 0)) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
    ), 0)::numeric(16,2) as funds_overdrawn,
    count(*) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
        and b.natural_balance < 0
    ) as overdrawn_accounts,
    coalesce(sum(b.natural_balance) filter (where b.purpose = 'gateway_clearing'), 0)::numeric(16,2) as funds_at_gateway
  from ledger_account_balances b
  group by b.org_id, b.currency;

do $$
declare
  d text; old_acl text;
  o constant text := $o$sum(b.natural_balance) filter (where b.purpose = 'client_funds') as funds_held$o$;
  n constant text := $n$sum(b.natural_balance) filter (where b.purpose in ('client_funds', 'gateway_clearing')) as funds_held$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.operator_consolidated_position(date, date)'::regprocedure;
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception 'operator_consolidated_position: expected funds_held exactly once';
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = 'public.operator_consolidated_position(date, date)'::regprocedure) is distinct from old_acl then
    raise exception 'operator_consolidated_position: grants changed by the rebuild';
  end if;
end $$;

-- ── 4. The four movements finance could not record ─────────────────────────
-- Shared gate: a signed-in, active Payment Officer or Payment Approver, and a
-- live client-funds bank account of their own organisation. Returns the bank
-- account row.
create or replace function ledger_movement_bank(p_bank_account_id uuid)
returns bank_accounts
language plpgsql stable security definer set search_path = public
as $$
declare
  b bank_accounts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'a movement has to be recorded by a person';
  end if;
  if not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  if current_user_role() is distinct from 'finance_approver' and current_user_role() is distinct from 'payment_approver' then
    raise exception 'only the Payment Officer or the Payment Approver records money moving between the organisation''s accounts';
  end if;
  select * into b from bank_accounts where id = p_bank_account_id;
  if b.id is null or b.org_id is distinct from current_user_org_id() then
    raise exception 'that bank account could not be found';
  end if;
  if b.purpose <> 'client_funds' or not b.active or b.ledger_account_id is null then
    raise exception 'that is not a live client-funds account';
  end if;
  return b;
end;
$$;

-- Settlement: the gateway paid out to the bank.
create or replace function record_gateway_settlement(
  p_bank_account_id uuid, p_gateway text, p_settled_on date, p_gross numeric, p_fees numeric, p_reference text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  b bank_accounts%rowtype;
  v_gateway text := lower(trim(coalesce(p_gateway, '')));
  v_clearing uuid; v_charges uuid; v_entry uuid; v_waiting numeric(16,2);
  v_ref text := trim(coalesce(p_reference, ''));
begin
  b := ledger_movement_bank(p_bank_account_id);
  if v_gateway not in ('paystack', 'flutterwave') then raise exception 'choose Paystack or Flutterwave'; end if;
  if p_settled_on is null or p_settled_on > current_date then raise exception 'the settlement date cannot be in the future'; end if;
  if p_gross is null or p_gross <= 0 then raise exception 'the settled transactions must total more than zero'; end if;
  if p_fees is null or p_fees < 0 or p_fees >= p_gross then raise exception 'the fees must be zero or more, and less than the transactions total'; end if;
  if length(v_ref) < 3 then raise exception 'give the gateway''s settlement reference, so the bank line can be matched to it'; end if;
  if exists (select 1 from ledger_entries where org_id = b.org_id and entity_type = 'gateway_settlement'
               and reference = v_ref and description ilike initcap(v_gateway) || '%') then
    raise exception 'a % settlement with reference % is already recorded', initcap(v_gateway), v_ref;
  end if;

  v_clearing := ensure_gateway_clearing_account(b.org_id, v_gateway, b.currency);
  select coalesce(natural_balance, 0) into v_waiting from ledger_account_balances where account_id = v_clearing;
  if coalesce(v_waiting, 0) < p_gross then
    raise exception 'the ledger shows only % waiting at %, less than the % this settlement covers. Check the figure, or whether the payments it covers were collected through this platform',
      to_char(coalesce(v_waiting, 0), 'FM999,999,999,990.00'), initcap(v_gateway), to_char(p_gross, 'FM999,999,999,990.00');
  end if;
  if p_fees > 0 then
    v_charges := canonical_ledger_account(b.org_id, 'bank_charges', b.currency);
    if v_charges is null then raise exception 'there is no bank charges account in %, so the fee cannot be recorded', b.currency; end if;
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source, entity_type, entity_id, created_by)
  values (b.org_id, p_settled_on, initcap(v_gateway) || ' settlement to ' || b.label, v_ref, 'adjustment',
          'gateway_settlement', b.id, auth.uid())
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (b.org_id, v_entry, b.ledger_account_id, p_gross - p_fees, 'Settled by ' || initcap(v_gateway) || ', net of fees'),
         (b.org_id, v_entry, v_clearing, -p_gross, 'Payments settled out of the ' || initcap(v_gateway) || ' balance');
  if p_fees > 0 then
    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values (b.org_id, v_entry, v_charges, p_fees, initcap(v_gateway) || ' fees on this settlement');
  end if;
  return v_entry;
end;
$$;

-- Top-up: the bank funded the gateway balance (for Paystack payouts).
create or replace function record_gateway_topup(
  p_bank_account_id uuid, p_gateway text, p_on date, p_amount numeric, p_reference text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  b bank_accounts%rowtype;
  v_gateway text := lower(trim(coalesce(p_gateway, '')));
  v_entry uuid; v_ref text := trim(coalesce(p_reference, ''));
begin
  b := ledger_movement_bank(p_bank_account_id);
  if v_gateway not in ('paystack', 'flutterwave') then raise exception 'choose Paystack or Flutterwave'; end if;
  if p_on is null or p_on > current_date then raise exception 'the date cannot be in the future'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be more than zero'; end if;
  if length(v_ref) < 3 then raise exception 'give the bank''s reference for the transfer'; end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source, entity_type, entity_id, created_by)
  values (b.org_id, p_on, 'Top-up of the ' || initcap(v_gateway) || ' balance from ' || b.label, v_ref, 'adjustment',
          'gateway_topup', b.id, auth.uid())
  returning id into v_entry;
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (b.org_id, v_entry, ensure_gateway_clearing_account(b.org_id, v_gateway, b.currency), p_amount, 'Paid into the ' || initcap(v_gateway) || ' balance'),
         (b.org_id, v_entry, b.ledger_account_id, -p_amount, 'Transferred to ' || initcap(v_gateway));
  return v_entry;
end;
$$;

-- A bank charge the statement shows.
create or replace function record_bank_charge(
  p_bank_account_id uuid, p_on date, p_amount numeric, p_reason text, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  b bank_accounts%rowtype; v_charges uuid; v_entry uuid;
begin
  b := ledger_movement_bank(p_bank_account_id);
  if p_on is null or p_on > current_date then raise exception 'the date cannot be in the future'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be more than zero'; end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'say what the charge was, in at least 10 characters'; end if;
  v_charges := canonical_ledger_account(b.org_id, 'bank_charges', b.currency);
  if v_charges is null then raise exception 'there is no bank charges account in %', b.currency; end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source, entity_type, entity_id, created_by)
  values (b.org_id, p_on, 'Bank charge: ' || trim(p_reason), nullif(trim(coalesce(p_reference, '')), ''), 'bank_charge',
          'bank_account', b.id, auth.uid())
  returning id into v_entry;
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (b.org_id, v_entry, v_charges, p_amount, trim(p_reason)),
         (b.org_id, v_entry, b.ledger_account_id, -p_amount, 'Charged by the bank');
  return v_entry;
end;
$$;

-- Funding an overdrawn account from the organisation's own money.
create or replace function fund_overdrawn_account(
  p_account_id uuid, p_bank_account_id uuid, p_on date, p_amount numeric, p_reference text, p_reason text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  b bank_accounts%rowtype; a ledger_accounts%rowtype; v_over numeric(16,2); v_entry uuid; v_place text;
begin
  b := ledger_movement_bank(p_bank_account_id);
  select * into a from ledger_accounts where id = p_account_id;
  if a.id is null or a.org_id is distinct from b.org_id then raise exception 'that account could not be found'; end if;
  if a.class <> 'liability' then raise exception 'only an account that is owed to someone can be overdrawn'; end if;
  if a.currency <> b.currency then raise exception 'the bank account and the overdrawn account are in different currencies'; end if;
  select greatest(-natural_balance, 0) into v_over from ledger_account_balances where account_id = a.id;
  if coalesce(v_over, 0) = 0 then raise exception 'that account is not overdrawn'; end if;
  if p_on is null or p_on > current_date then raise exception 'the date cannot be in the future'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be more than zero'; end if;
  if p_amount > v_over then
    raise exception 'that account is overdrawn by only %; fund that much, not more', to_char(v_over, 'FM999,999,999,990.00');
  end if;
  if length(trim(coalesce(p_reference, ''))) < 3 then raise exception 'give the bank''s reference for the money paid in'; end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'say where the money came from, in at least 10 characters'; end if;
  select name into v_place from properties where id = a.property_id;

  insert into ledger_entries (org_id, entry_date, description, reference, source, entity_type, entity_id, created_by)
  values (b.org_id, p_on, 'Overdrawn account funded: ' || coalesce(v_place, a.name), trim(p_reference), 'adjustment',
          'ledger_account', a.id, auth.uid())
  returning id into v_entry;
  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (b.org_id, v_entry, b.ledger_account_id, p_amount, 'Paid in from the organisation''s own money: ' || trim(p_reason)),
         (b.org_id, v_entry, a.id, -p_amount, 'Restores money this account had spent beyond what it held');
  return v_entry;
end;
$$;

-- ── 5. Grants, stated in full ──────────────────────────────────────────────
revoke all on function ensure_gateway_clearing_account(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function ledger_movement_bank(uuid) from public, anon, authenticated, service_role;
revoke all on function record_gateway_settlement(uuid, text, date, numeric, numeric, text) from public, anon, authenticated, service_role;
revoke all on function record_gateway_topup(uuid, text, date, numeric, text) from public, anon, authenticated, service_role;
revoke all on function record_bank_charge(uuid, date, numeric, text, text) from public, anon, authenticated, service_role;
revoke all on function fund_overdrawn_account(uuid, uuid, date, numeric, text, text) from public, anon, authenticated, service_role;

grant execute on function record_gateway_settlement(uuid, text, date, numeric, numeric, text) to authenticated;
grant execute on function record_gateway_topup(uuid, text, date, numeric, text) to authenticated;
grant execute on function record_bank_charge(uuid, date, numeric, text, text) to authenticated;
grant execute on function fund_overdrawn_account(uuid, uuid, date, numeric, text, text) to authenticated;

do $$
declare bad text;
begin
  select string_agg(routine_name || '→' || grantee, ', ') into bad
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and (
       (routine_name in ('ensure_gateway_clearing_account', 'ledger_movement_bank') and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role'))
       or (routine_name in ('record_gateway_settlement', 'record_gateway_topup', 'record_bank_charge', 'fund_overdrawn_account')
           and grantee in ('PUBLIC', 'anon', 'service_role'))
     );
  if bad is not null then raise exception 'ledger movement functions over-granted: %', bad; end if;

  if not exists (select 1 from pg_class where oid = 'public.client_funds_position'::regclass and reloptions @> array['security_invoker=on']) then
    raise exception 'client_funds_position lost security_invoker';
  end if;
end $$;
