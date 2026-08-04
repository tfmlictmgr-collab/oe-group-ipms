-- Flutterwave, made real — not just an adapter class with no application path.
--
-- ⚠️ The gap this closes is not "Flutterwave has no API key". It is that the
-- LEDGER cannot safely hold a non-Naira collection at all today:
--
--   • `ledger_accounts` has no currency column. Every account — 'client_funds',
--     'suspense', all of it — is implicitly the org's one currency.
--   • `bank_accounts_one_client_funds_uidx` permits exactly ONE active
--     client-funds bank account per org, full stop. There is structurally no
--     way to add a second, USD-denominated one without dropping it.
--   • `canonical_ledger_account()` / `collection_bank_account()` resolve "the"
--     account for a purpose with `limit 1` and no currency filter. If a second
--     currency's accounts existed, these would pick between them arbitrarily.
--   • `client_funds_position` — "the single most important number in the
--     system" per its own comment — sums `funds_held` and `funds_owed` across
--     the WHOLE org with no currency grouping. A ₦4,000,000 balance and a
--     $10,000 balance would be added together as 4,010,000 of nothing.
--
-- So a USD collection posted through the code as it stood would either be
-- refused outright (no second client-funds account possible) or, worse, land
-- in the Naira accounts and silently misstate the segregation position — the
-- one figure this whole ledger exists to keep honest (CLAUDE.md decision 2).
-- "Wire up Flutterwave" without this is building a button that corrupts the
-- books the first time someone clicks it in anger.
--
-- What is NOT changed: invariant enforcement itself. `assert_funds_available()`
-- already checks balance PER ACCOUNT ROW (`v_account := ... account_id`), not
-- per purpose aggregated across accounts — so a USD client_funds account and an
-- NGN client_funds account are already two independent balances as far as
-- "cannot go negative" is concerned. Only the RESOLVERS (which account is
-- "the" one for a purpose) and the DISPLAY aggregates (which sum across
-- accounts) needed to learn about currency.
--
-- Every existing call site keeps working unchanged: the new parameter on both
-- resolver functions defaults to 'NGN', so a caller that has never heard of
-- multi-currency gets exactly the Naira account it always got.

-- ── 1. Currency joins the chart of accounts ─────────────────────────────────
alter table ledger_accounts add column if not exists currency text not null default 'NGN';
alter table ledger_accounts add constraint ledger_accounts_currency_format
  check (currency ~ '^[A-Z]{3}$');

comment on column ledger_accounts.currency is
  'ISO 4217. Defaults NGN so every account created before this migration is
   correctly NGN by construction, not by inference. An account for a purpose
   exists once PER CURRENCY, not once per org — resolve it through
   canonical_ledger_account(org_id, purpose, currency), never by purpose alone.';

-- Existing rows are already correct at default; nothing to backfill.

-- ── 2. A bank account exists once per (org, currency), not once per org ────
drop index if exists bank_accounts_one_client_funds_uidx;
create unique index bank_accounts_one_client_funds_per_currency_uidx
  on bank_accounts (org_id, currency) where purpose = 'client_funds' and active;

comment on index bank_accounts_one_client_funds_per_currency_uidx is
  'One live client-funds account per CURRENCY, not per org (was per org before
   Flutterwave/FX collections — 0103). Two NGN accounts would still make the
   segregated NGN balance ambiguous; a USD account beside the NGN one is a
   different, independently-segregated balance, not a duplicate.';

-- ── 3. Provisioning a currency's minimal chart, on request ─────────────────
--
-- Deliberately narrower than `ensure_default_ledger_accounts`: an FX collection
-- under B3 is COLLECTIONS ONLY (Flutterwave refuses payouts outright — see
-- `FlutterwaveAdapter.transfer()`), so nothing in a foreign currency is ever
-- owed onward to a landlord or vendor from THIS function's own accounts. The
-- two accounts an FX collection can ever touch are the bank itself
-- (client_funds) and, for anything not cleanly a rent/service-charge/deposit
-- obligation, suspense — pending a human deciding what it actually is.
create or replace function ensure_currency_ledger_accounts(p_org_id uuid, p_currency text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_currency text := upper(trim(p_currency));
begin
  if current_user_role() is distinct from 'admin'
     or current_user_org_id() is distinct from p_org_id then
    if auth.uid() is not null then
      raise exception 'only an administrator of this organisation may enable a currency';
    end if;
  end if;

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'not a currency code: %', p_currency;
  end if;
  if v_currency = 'NGN' then
    -- The standard chart already carries NGN; nothing to add.
    return;
  end if;

  insert into ledger_accounts (org_id, code, name, class, purpose, currency)
  values
    (p_org_id, '1000-' || v_currency, 'Client funds (bank) — ' || v_currency,
     'asset', 'client_funds', v_currency),
    (p_org_id, '9000-' || v_currency, 'Suspense (unidentified) — ' || v_currency,
     'liability', 'suspense', v_currency)
  on conflict do nothing;
end;
$$;

revoke all on function ensure_currency_ledger_accounts(uuid, text) from public;
grant execute on function ensure_currency_ledger_accounts(uuid, text) to authenticated, service_role;

comment on function ensure_currency_ledger_accounts(uuid, text) is
  'Provisions the client_funds + suspense pair for a foreign currency (B3: FX is
   collections-only, so nothing else is needed). Idempotent. Mirrors
   ensure_default_ledger_accounts (0028) but deliberately does not create
   landlord/vendor/deposit/service-charge accounts in the new currency — those
   are domestic-Naira obligations by design (decision 15), not FX ones.';

-- ── 4. The resolvers learn a currency, defaulting to NGN ────────────────────
--
-- ⚠️ `create or replace function foo(a, b default X)` does NOT replace an
-- existing `foo(a)` — Postgres identifies a function by name **and parameter
-- types**, and `(uuid)` and `(uuid, text)` are different signatures. Without
-- the explicit drops below, both overloads exist simultaneously, and a caller
-- supplying only the original argument becomes AMBIGUOUS: confirmed live —
-- `collection_bank_account(p_org_id => <uuid>)` failed with "Could not choose
-- the best candidate function between: ...(uuid), ...(uuid, text)" the moment
-- this migration first ran, breaking every existing 1-argument caller
-- (`record_opening_balance`'s allocation lookups, `bank-actions.ts`,
-- `verify-collections`) rather than leaving them untouched as intended.
--
-- With the old signature dropped first, only ONE overload exists and the new
-- parameter's default ('NGN') is what makes a 1-argument call keep working —
-- which was the actual intent, achieved the way Postgres requires rather than
-- the way that reads more obviously "additive".
drop function if exists canonical_ledger_account(uuid, ledger_account_purpose);
drop function if exists collection_bank_account(uuid);

create or replace function canonical_ledger_account(
  p_org_id uuid,
  p_purpose ledger_account_purpose,
  p_currency text default 'NGN'
)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  return (
    select a.id
      from ledger_accounts a
     where a.org_id = p_org_id
       and a.purpose = p_purpose
       and a.currency = upper(trim(p_currency))
       and a.active
     order by (a.code ~ '^[0-9]+(-[A-Z]{3})?$') desc, a.code, a.created_at, a.id
     limit 1
  );
end;
$$;

create or replace function collection_bank_account(p_org_id uuid, p_currency text default 'NGN')
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_currency text := upper(trim(p_currency));
begin
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  return coalesce(
    (select b.ledger_account_id
       from bank_accounts b
      where b.org_id = p_org_id
        and b.purpose = 'client_funds'
        and b.currency = v_currency
        and b.active
        and b.ledger_account_id is not null
      limit 1),
    canonical_ledger_account(p_org_id, 'client_funds', v_currency)
  );
end;
$$;

revoke all on function canonical_ledger_account(uuid, ledger_account_purpose, text) from public;
revoke all on function collection_bank_account(uuid, text) from public;
grant execute on function canonical_ledger_account(uuid, ledger_account_purpose, text)
  to service_role, authenticated;
grant execute on function collection_bank_account(uuid, text) to service_role, authenticated;

comment on function canonical_ledger_account(uuid, ledger_account_purpose, text) is
  'Default ledger account for a purpose IN A CURRENCY (0103 added currency;
   defaults NGN so every pre-existing caller is unaffected). SECURITY DEFINER:
   verifies the caller belongs to p_org_id (service role exempt).';
comment on function collection_bank_account(uuid, text) is
  'Ledger account incoming client money of a given CURRENCY is debited to
   (0103 added currency; defaults NGN). SECURITY DEFINER: verifies the caller
   belongs to p_org_id (service role exempt).';

-- ── 5. record_collection resolves by the intent's own currency ─────────────
--
-- `payment_intents.currency` already exists and is `not null default 'NGN'`
-- (0032) — every rent/service-charge/deposit collection today already carries
-- 'NGN' explicitly, so passing it through changes nothing for them. Only a
-- genuinely non-NGN intent (raised via Flutterwave) now resolves into ITS OWN
-- currency's accounts instead of falling through to whatever `limit 1`
-- happened to return.
create or replace function record_collection(
  p_intent_id uuid,
  p_amount_verified numeric,
  p_paid_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  intent payment_intents%rowtype;
  rc rent_charges%rowtype;
  v_bank uuid;
  v_credit uuid;
  v_fee uuid;
  v_purpose ledger_account_purpose;
  v_entry uuid;
  v_mismatch boolean;
  v_status payment_intent_status;
  v_fee_total numeric(16,2);
  v_landlord_share numeric(16,2);
begin
  select * into intent from payment_intents where id = p_intent_id for update;
  if intent.id is null then
    raise exception 'payment intent not found';
  end if;

  if intent.ledger_entry_id is not null then
    return intent.ledger_entry_id;
  end if;

  if p_amount_verified is null or p_amount_verified <= 0 then
    raise exception 'a collection must have a positive verified amount';
  end if;

  v_purpose := case intent.purpose
    when 'rent' then 'landlord_payable'
    when 'service_charge' then 'service_charge_fund'
    when 'deposit' then 'tenant_deposit'
    else 'suspense'
  end;

  v_bank := collection_bank_account(intent.org_id, intent.currency);
  v_credit := canonical_ledger_account(intent.org_id, v_purpose, intent.currency);

  if v_bank is null or v_credit is null then
    -- Distinct from the NGN case in wording, not in code path: this is the
    -- refusal an admin sees if a checkout somehow got raised for a currency
    -- nobody enabled a client-funds account for.
    raise exception 'no client-funds account is configured for % — enable it under Settings before collecting in this currency', intent.currency;
  end if;

  if intent.rent_charge_id is not null then
    select * into rc from rent_charges where id = intent.rent_charge_id for update;
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    intent.org_id, p_paid_at::date,
    'Collection — ' || replace(intent.purpose::text, '_', ' ')
      || case when intent.currency <> 'NGN' then ' (' || intent.currency || ')' else '' end,
    intent.gateway_reference, 'collection',
    'payment_intent', intent.id, intent.created_by
  )
  returning id into v_entry;

  if rc.id is not null then
    -- The fee, taken once, from the rate frozen when the demand was raised, and
    -- apportioned to what was actually received — so a part payment does not
    -- hand the org its whole fee out of the landlord's first instalment.
    v_fee_total := round(
      (rc.management_fee_amount + rc.admin_fee_amount) * (p_amount_verified / rc.amount), 2
    );
    if v_fee_total < 0 then v_fee_total := 0; end if;
    if v_fee_total > p_amount_verified then v_fee_total := p_amount_verified; end if;

    v_landlord_share := p_amount_verified - v_fee_total;

    -- Rent is a domestic Naira obligation (decision 15) — fee income is
    -- resolved in the intent's own currency all the same, which is a no-op
    -- today (rent intents are always NGN) and correct if that ever changes.
    v_fee := canonical_ledger_account(intent.org_id, 'fee_income', intent.currency);
    if v_fee is null then
      raise exception 'the chart of accounts has no fee income account for this organisation';
    end if;

    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values (intent.org_id, v_entry, v_bank, p_amount_verified,
            'Rent received via ' || intent.gateway);

    if v_landlord_share > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (intent.org_id, v_entry, v_credit, -v_landlord_share,
              'Held for the landlord, net of fees');
    end if;

    if v_fee_total > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (intent.org_id, v_entry, v_fee, -v_fee_total,
              'Management and admin fee at ' || rc.management_fee_pct || '%');
    end if;

    update rent_charges
       set amount_paid = amount_paid + p_amount_verified,
           status = case
             when amount_paid + p_amount_verified >= amount then 'paid'::rent_charge_status
             else 'part_paid'::rent_charge_status
           end,
           ledger_entry_id = coalesce(ledger_entry_id, v_entry)
     where id = rc.id;
  else
    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values
      (intent.org_id, v_entry, v_bank, p_amount_verified, 'Received via ' || intent.gateway),
      (intent.org_id, v_entry, v_credit, -p_amount_verified, 'Held on behalf of the payer');
  end if;

  v_mismatch := p_amount_verified <> intent.amount_expected;
  v_status := case when p_amount_verified >= intent.amount_expected
                   then 'paid'::payment_intent_status
                   else 'part_paid'::payment_intent_status end;

  update payment_intents
     set status = v_status,
         amount_paid = p_amount_verified,
         paid_at = p_paid_at,
         ledger_entry_id = v_entry,
         amount_mismatch = v_mismatch
   where id = intent.id;

  return v_entry;
end;
$$;

revoke all on function record_collection(uuid, numeric, timestamptz) from public;
grant execute on function record_collection(uuid, numeric, timestamptz) to service_role;

-- ── 6. The segregation position, per currency ───────────────────────────────
--
-- ⚠️ This was the sharpest edge in the whole change. "The single most important
-- number in the system" (its own 0027 comment) summed `funds_held` and
-- `funds_owed` across the ENTIRE org with no currency grouping. The moment a
-- second currency's accounts carried any balance, this view would silently add
-- Naira and Dollars together and report a shortfall or a surplus that means
-- nothing — on the one screen whose entire purpose is catching exactly that
-- kind of quiet corruption.
-- ⚠️ `currency` is APPENDED at the end of the select list, not inserted where it
-- would naturally read (beside `purpose`). `create or replace view` refuses to
-- change an existing output column's ordinal position or name — Postgres:
-- "cannot change name of view column ... to currency" — because a dependent
-- view or an application selecting by position would silently start reading the
-- wrong data. Since `client_funds_position` selects FROM this view, an ordinal
-- shift here would have broken it too. Adding new columns only at the end is
-- the one shape `create or replace view` accepts without a drop.
create or replace view ledger_account_balances as
  select
    a.id as account_id, a.org_id, a.code, a.name, a.class, a.purpose,
    a.counterparty_user_id, a.counterparty_vendor_id, a.property_id, a.active,
    coalesce(sum(p.amount), 0)::numeric(16,2) as balance,
    case
      when a.class in ('asset', 'expense') then coalesce(sum(p.amount), 0)
      else -coalesce(sum(p.amount), 0)
    end::numeric(16,2) as natural_balance,
    count(p.id) as posting_count,
    max(p.created_at) as last_posted_at,
    a.currency
  from ledger_accounts a
  left join ledger_postings p on p.account_id = a.id
  group by a.id;

-- Same reason for the placement here: `currency` moves into the GROUP BY (it
-- must, to stop cross-currency summing) but the SELECT list gains it only as a
-- trailing column, for the same ordinal-stability reason as the view above.
create or replace view client_funds_position as
  select
    b.org_id,
    sum(b.natural_balance) filter (where b.purpose = 'client_funds') as funds_held,
    sum(b.natural_balance) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
    ) as funds_owed,
    (
      coalesce(sum(b.natural_balance) filter (where b.purpose = 'client_funds'), 0)
      - coalesce(sum(b.natural_balance) filter (
          where b.class = 'liability'
            and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
        ), 0)
    )::numeric(16,2) as unallocated,
    b.currency
  from ledger_account_balances b
  group by b.org_id, b.currency;

comment on view client_funds_position is
  'The segregation check — money held vs money owed — grouped by (org, currency).
   0103: was grouped by org alone, which summed every currency''s balances into
   one meaningless figure the moment a second currency existed. Suspense
   deliberately counts toward funds_held but NOT funds_owed (0027) — an
   unidentified receipt is still money that must be accounted for, but nothing
   has yet been promised to anyone against it; this holds per currency exactly
   as it held for the single implicit currency before.';

-- security_invoker carries over automatically on `create or replace view` —
-- Postgres does not reset it, but restated for anyone reading this migration in
-- isolation without the 0027 context.
alter view ledger_account_balances set (security_invoker = on);
alter view client_funds_position set (security_invoker = on);

-- ── 7. Opening-balance allocation cannot cross currencies ───────────────────
--
-- `record_opening_balance` (0048) trusts whatever `accountId` each allocation
-- line names — safe when only one currency's liability accounts could ever be
-- offered, which was true until this migration. The UI now filters the picker
-- to the bank account's own currency (`CurrencyAccountsManager`), but this
-- function is SECURITY DEFINER and independently callable; the UI filtering it
-- correctly is not the same as the function enforcing it. Defence in depth,
-- same reasoning as every other money-path function in this codebase: the
-- database is the boundary, the UI is a courtesy.
create or replace function record_opening_balance(
  p_bank_account_id uuid,
  p_as_of date,
  p_allocations jsonb          -- [{"accountId": uuid, "amount": numeric}, ...]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  bank bank_accounts%rowtype;
  v_total numeric(16,2) := 0;
  v_entry uuid;
  v_line jsonb;
  v_role user_role := current_user_role();
  v_line_currency text;
begin
  select * into bank from bank_accounts where id = p_bank_account_id for update;
  if bank.id is null then
    raise exception 'that bank account could not be found';
  end if;

  if auth.uid() is not null then
    if bank.org_id is distinct from current_user_org_id() then
      raise exception 'that bank account belongs to another organisation';
    end if;
    if v_role is distinct from 'admin' and v_role is distinct from 'finance_approver' then
      raise exception 'only an administrator or finance approver can record an opening balance';
    end if;
  end if;

  if bank.opening_entry_id is not null then
    raise exception 'an opening balance has already been recorded for this account';
  end if;
  if bank.ledger_account_id is null then
    raise exception 'this bank account is not linked to a ledger account yet';
  end if;

  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_total := v_total + coalesce((v_line->>'amount')::numeric, 0);

    -- The new check. A landlord's Naira balance and a bank's USD opening
    -- balance are not interchangeable money — allocating one into the other's
    -- liability account would misstate whose money is held in which currency,
    -- even though the balancing trigger (which only checks that debits and
    -- credits sum to zero, not that they agree on currency) would not catch it.
    if coalesce((v_line->>'amount')::numeric, 0) > 0 then
      select currency into v_line_currency
        from ledger_accounts where id = (v_line->>'accountId')::uuid;
      if v_line_currency is distinct from bank.currency then
        raise exception
          'allocation account is in % but this bank account is %',
          coalesce(v_line_currency, 'an unknown currency'), bank.currency;
      end if;
    end if;
  end loop;

  if v_total <= 0 then
    raise exception 'an opening balance needs at least one positive allocation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, source,
                              entity_type, entity_id, created_by)
  values (bank.org_id, p_as_of, 'Opening balance — ' || bank.label,
          'opening_balance', 'bank_account', bank.id, auth.uid())
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (bank.org_id, v_entry, bank.ledger_account_id, v_total,
          'Funds held at go-live');

  for v_line in select * from jsonb_array_elements(p_allocations) loop
    if coalesce((v_line->>'amount')::numeric, 0) > 0 then
      insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
      values (bank.org_id, v_entry, (v_line->>'accountId')::uuid,
              -((v_line->>'amount')::numeric), 'Opening allocation');
    end if;
  end loop;

  update bank_accounts
     set opening_balance = v_total, opening_date = p_as_of, opening_entry_id = v_entry
   where id = bank.id;

  return jsonb_build_object('total', v_total, 'entryId', v_entry);
end;
$$;

revoke all on function record_opening_balance(uuid, date, jsonb) from public;
grant execute on function record_opening_balance(uuid, date, jsonb) to authenticated, service_role;

comment on function record_opening_balance(uuid, date, jsonb) is
  'Posts a bank account''s opening balance as a real, balanced ledger entry.
   0103: every allocation line must be in the SAME currency as the bank
   account — refused otherwise, not silently accepted. SECURITY DEFINER:
   verifies the caller''s org and role itself.';
