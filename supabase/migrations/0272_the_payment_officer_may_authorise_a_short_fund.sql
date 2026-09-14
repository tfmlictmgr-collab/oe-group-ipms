-- The payment officer may authorise a short fund, on the record
-- (board, 7 Sept 2026).
--
-- Reported from the live OEA portal, with the refusal on screen:
--
--   "Osborne Tower's service-charge fund cannot cover this — it would be left
--    short by 247,272.27. Only money collected for this property can be spent
--    on it… Nothing has been sent."
--
-- All three approval stages were complete. The block is `assert_funds_available`
-- (0027, made per-property by 0247) doing exactly what decision 2 asks of it:
-- keeping one building's tenants' money from paying another building's bills.
--
-- ── What was asked, what was advised, and what was decided ───────────────
--
-- Asked: "add the option for the payment officer to source funding from other
-- projects to bypass this kind of blocker."
--
-- Advised against, in writing, with the alternative offered: a recorded
-- inter-property transfer, approved and visible on both properties' statements,
-- so the segregation stays true and the borrowing is a fact on the record.
--
-- ⚠️ **The board chose the override.** It is built here as chosen — the payment
-- officer can push past the block — and it is built ATTRIBUTABLE rather than
-- silent: a named person, a stated reason of at least 20 characters, an audit
-- row, single use, and the shortfall it permitted recorded against the account
-- it was spent from. That is not a narrowing of the decision; it is the same
-- act with a trail, and the trail is what an auditor will ask for.
--
-- **This should be minuted as an exception to decisions 2 and 27.**
--
-- ── What the override does NOT reach, and why that is not me narrowing it ─
--
-- Three different refusals live in `assert_funds_available` and only one of
-- them is the one on the screenshot:
--
--   1. **A property's service-charge fund would be short** — the segregation
--      rule, the one reported, the one this overrides.
--   2. **The client-funds account would go overdrawn** — money leaving a bank
--      account that never received it. Not a policy preference: the payment
--      would fail at the bank, and posting it would make the ledger disagree
--      with reality. Untouched.
--   3. **A payee would be paid more than is owed to them** — an overpayment to
--      a named counterparty. Untouched: nothing about a short fund makes it
--      right to send a vendor more than their approved invoice.
--
-- Overriding (2) or (3) would not "source funding from another project"; it
-- would post money that does not exist, or pay somebody twice. The request was
-- about the first, and the first is what opens.

create table if not exists fund_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  account_id uuid not null references ledger_accounts(id),
  -- 20 characters, not 10. A refusal reason is read by a colleague; this is
  -- read by an auditor asking why one building's fund paid another's bill.
  reason text not null check (length(trim(reason)) >= 20),
  authorised_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  -- What it was short by at the moment it was authorised, so the record says
  -- how big the exception was and not merely that one was made.
  shortfall_at_authorisation numeric(16,2),
  consumed_at timestamptz,
  consumed_entry_id uuid references ledger_entries(id)
);

create index if not exists fund_overrides_live_idx
  on fund_overrides (account_id) where consumed_at is null;

comment on table fund_overrides is
  'A payment officer''s authorisation to send a payment a property''s service-charge fund cannot cover (board, 7 Sept 2026 — an exception to decisions 2 and 27). Single use: consumed by the first posting it lets through, so an authorisation is for ONE payment and never a standing permission. Never applies to a client-funds overdraft or to overpaying a counterparty — those are not funding questions.';

alter table fund_overrides enable row level security;

-- Read by the desks that can already see the money: oversight and the payment
-- chain. Written by nobody directly — `authorise_fund_override` is the one path.
drop policy if exists fund_overrides_select on fund_overrides;
create policy fund_overrides_select on fund_overrides for select to authenticated
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (payment_chain_roles())
    )
  );

-- ── Authorising one ──────────────────────────────────────────────────────
--
-- ⚠️ `finance_approver` alone, and that is decision 16 applied rather than
-- invented: only the payment officer disburses, so only the payment officer can
-- authorise a disbursement the fund cannot cover. An administrator cannot —
-- decision 23 took them out of money approval entirely, and letting them
-- unblock a payment they are not permitted to approve would be that removal
-- undone through a side door.
create or replace function authorise_fund_override(
  p_account_id uuid,
  p_reason text
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  acct ledger_accounts%rowtype;
  v_balance numeric(16,2);
  v_place text;
begin
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
  if auth.uid() is null then
    raise exception 'an override has to be authorised by a person';
  end if;

  if current_user_role() is distinct from 'finance_approver' then
    raise exception
      'only the payment officer may authorise a payment the fund cannot cover — oversight authorises, the payment officer disburses';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 20 then
    raise exception
      'say where the money is coming from and why, in at least 20 characters — this is read by whoever asks why one property''s fund paid another''s bill';
  end if;

  select * into acct from ledger_accounts where id = p_account_id;
  if acct.id is null then
    raise exception 'that fund account could not be found';
  end if;
  if acct.org_id is distinct from current_user_org_id() then
    raise exception 'that fund account belongs to another organisation';
  end if;

  -- ⚠️ Only the fund it was asked for. A client-funds account or a
  -- counterparty payable reaching this function is a caller pointing the
  -- override at a refusal it was never granted for.
  if not (acct.purpose = any (property_scoped_ledger_purposes())) then
    raise exception
      'this account is not a property fund — an override covers a short service-charge fund, never an overdrawn bank account or an overpaid payee';
  end if;

  select coalesce(sum(amount), 0) into v_balance from ledger_postings where account_id = acct.id;
  select name into v_place from properties where id = acct.property_id;

  insert into fund_overrides (org_id, account_id, reason, authorised_by, shortfall_at_authorisation)
  values (acct.org_id, acct.id, trim(p_reason), auth.uid(), greatest(v_balance, 0))
  returning id into v_id;

  -- Written explicitly rather than left to a table trigger: this is a stated
  -- exception to a segregation control, and the audit row should read as a
  -- sentence an auditor understands rather than as a column diff.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    acct.org_id, auth.uid(), 'funds.override_authorised', 'ledger_accounts', acct.id,
    jsonb_build_object('property', v_place, 'account', acct.code),
    jsonb_build_object('reason', trim(p_reason), 'shortfall', greatest(v_balance, 0))
  );

  return v_id;
end;
$fn$;

revoke all on function authorise_fund_override(uuid, text) from public, anon;
grant execute on function authorise_fund_override(uuid, text) to authenticated, service_role;

comment on function authorise_fund_override is
  'The payment officer authorises ONE payment a property''s service-charge fund cannot cover (board, 7 Sept 2026; an exception to decisions 2 and 27). Requires a reason of 20 characters, writes an audit row naming the property and the shortfall, and is consumed by the first posting it admits.';

-- ── The guard learns about it ────────────────────────────────────────────
--
-- Rebuilt from `pg_get_functiondef` (0183). Two of the three refusals are
-- byte-identical; only the property-fund branch consults an override, and it
-- CONSUMES it in the same statement so one authorisation admits one payment.
create or replace function assert_funds_available()
returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_account uuid := coalesce(new.account_id, old.account_id);
  acct ledger_accounts%rowtype;
  v_balance numeric(16,2);
  v_place text;
  v_money text;
  v_override uuid;
begin
  select * into acct from ledger_accounts where id = v_account;
  if acct.id is null then return null; end if;

  select coalesce(sum(amount), 0) into v_balance
  from ledger_postings where account_id = v_account;

  -- Client funds are an asset: debit-normal, so the balance is what is held.
  -- Negative means money has been disbursed that was never received.
  --
  -- ⚠️ NOT overridable, and deliberately so. This is not a rule about which
  -- building's money is being used; it is the ledger refusing to record money
  -- leaving an account that never received it. The bank would refuse it too.
  if acct.purpose = 'client_funds' and v_balance < 0 then
    raise exception
      'The % client-funds account would go overdrawn by %. You cannot pay out money the bank account has not received.',
      acct.currency, to_char(-v_balance, 'FM999,999,999,990.00');
  end if;

  -- Liabilities are credit-normal, so a NEGATIVE balance is what is owed and a
  -- POSITIVE balance means we have paid out more than we owe — i.e. we have
  -- spent someone else's money. This is the segregation guarantee.
  if acct.class = 'liability' and v_balance > 0 then
    v_money := to_char(v_balance, 'FM999,999,999,990.00');

    if acct.purpose = any (property_scoped_ledger_purposes()) then
      -- 0272. A live authorisation from the payment officer, consumed here so
      -- it admits exactly one payment. Taken BEFORE the message is composed:
      -- an override that fires should leave no refusal behind it.
      update fund_overrides o
         set consumed_at = now(),
             consumed_entry_id = coalesce(new.entry_id, old.entry_id)
       where o.id = (
         select o2.id from fund_overrides o2
          where o2.account_id = v_account and o2.consumed_at is null
          order by o2.created_at
          limit 1
       )
      returning o.id into v_override;

      if v_override is not null then
        return null;
      end if;

      if acct.property_id is not null then
        select name into v_place from properties where id = acct.property_id;
        raise exception
          '%''s service-charge fund cannot cover this — it would be left short by %. Only money collected for this property can be spent on it, so either collect the outstanding service charge, or raise this against the property whose fund should bear it.',
          coalesce(v_place, 'This property'), v_money;
      else
        raise exception
          'This payment is not attached to a property, so it draws on the organisation-wide service-charge fund — and that fund would be left short by %. Attach it to a property with a service request, or collect first.',
          v_money;
      end if;
    end if;

    -- ⚠️ NOT overridable. Paying a payee more than is owed to them is not a
    -- funding problem and no amount of money in another building's fund makes
    -- it right.
    if acct.counterparty_vendor_id is not null or acct.counterparty_user_id is not null then
      raise exception
        'This would pay % more than is owed to this payee. Check the amount against the invoice or requisition that was approved.',
        v_money;
    end if;

    raise exception
      'Account % (%) would be left overdrawn by %. Nothing has been posted.',
      acct.code, acct.name, v_money;
  end if;

  return null;
end;
$fn$;

revoke all on function assert_funds_available() from public, anon;
grant execute on function assert_funds_available() to authenticated, service_role;

-- ── The funding state says whether one is standing ───────────────────────
--
-- The queue already asks "can this fund cover it" before the send (0247). It
-- now also answers "and has somebody authorised it anyway", so the screen can
-- say which of the two is true rather than offering a button whose effect the
-- reader has to guess.
create or replace function payable_fund_override_state(p_payable_type text, p_payable_id uuid)
returns table (
  account_id uuid,
  authorised boolean,
  reason text,
  authorised_by text,
  authorised_at timestamptz
)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_prop uuid;
  v_acct uuid;
begin
  if p_payable_type = 'vendor_payment' then
    select p.org_id into v_org from payments p where p.id = p_payable_id;
  elsif p_payable_type = 'ops_requisition' then
    select r.org_id into v_org from ops_requisitions r where r.id = p_payable_id;
  else
    return;
  end if;
  if v_org is null then return; end if;
  if auth.uid() is not null and v_org is distinct from current_user_org_id() then
    raise exception 'that payable belongs to another organisation';
  end if;

  v_prop := payable_property_id(p_payable_type, p_payable_id);

  select la.id into v_acct
    from ledger_accounts la
   where la.org_id = v_org
     and la.purpose = 'service_charge_fund'
     and la.currency = 'NGN'
     and la.property_id is not distinct from v_prop;

  return query
  select
    v_acct,
    o.id is not null,
    o.reason,
    u.full_name,
    o.created_at
  from (select 1) _
  left join lateral (
    select * from fund_overrides fo
     where fo.account_id = v_acct and fo.consumed_at is null
     order by fo.created_at limit 1
  ) o on true
  left join users u on u.id = o.authorised_by;
end;
$fn$;

revoke all on function payable_fund_override_state(text, uuid) from public, anon;
grant execute on function payable_fund_override_state(text, uuid) to authenticated, service_role;

-- ── Prove the two that must NOT open ─────────────────────────────────────
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'assert_funds_available';

  -- The override lookup must appear exactly once, inside the property-fund
  -- branch. If it ever wraps the whole function, a payment officer could post
  -- money the bank never received.
  if (length(v_def) - length(replace(v_def, 'fund_overrides', ''))) / length('fund_overrides') <> 2 then
    raise exception 'the fund override is consulted more than once — it must reach only the property-fund refusal';
  end if;
  if v_def !~ 'client-funds account would go overdrawn' then
    raise exception 'the client-funds overdraft refusal has gone';
  end if;
  if v_def !~ 'more than is owed to this payee' then
    raise exception 'the counterparty overpayment refusal has gone';
  end if;
end $$;
