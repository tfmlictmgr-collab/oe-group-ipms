-- The service-charge fund belongs to a property, and a refusal says which one
-- (decision 27, 5 Sept 2026).
--
-- Reported from the live OEA portal: the payment officer could not send a
-- ₦21,000 requisition. The screen said, in full:
--
--     "account 2000 would be overpaid by 21000.00 — a counterparty cannot be
--      paid more than is owed to them. Nothing has been sent."
--
-- Measured on staging, that message was three things at once, and only one of
-- them was true.
--
--   • It was RIGHT to refuse. `assert_funds_available` (0027) exists to stop
--     service-charge money being spent before it is collected, and OEA's
--     account 2000 held ₦0.00 at the time — the ₦405,927.73 now on it was
--     collected on 4 Sept, after the refusal. The overpayment figure equals the
--     requisition total exactly, which is the arithmetic of committing ₦21,000
--     against an empty fund.
--   • It named a CONCEPT THAT DOES NOT APPLY. Account 2000 is
--     `service_charge_fund` — a pooled source of funds with no
--     `counterparty_user_id` and no `counterparty_vendor_id`. Nobody was being
--     overpaid. The sentence belongs to 2200/2400, which genuinely are one row
--     per payee; it was being printed for an account of an entirely different
--     kind because both are `class = 'liability'`.
--   • It could not name WHICH BUILDING was short, because there was only ever
--     one row to be short. `ensure_default_ledger_accounts` seeds exactly one
--     2000 per org and `canonical_ledger_account` (0036) resolves it by
--     `(org_id, purpose, currency)` — never by property. So every property's
--     collections credited one balance and every property's vendor invoices and
--     ops requisitions debited it. Osborne Tower's fund and Parkview Terraces'
--     fund were the same number.
--
-- ⚠️ That last point is not merely a message problem. Decision 2 requires "a
-- segregated client-funds account, an in-app segregated ledger". A single
-- pooled balance is the opposite of segregated: it lets one building's shortfall
-- block another building's fully-collected payment, and — the direction that
-- actually matters — it lets one building's vendor be paid out of another
-- building's tenants' money without anything in the schema noticing. The
-- comment in 0027 line 34 already called this account "SC collected **for a
-- property's** budget". The column to do it with (`ledger_accounts.property_id`)
-- has existed since then and was never once populated: measured live, 0 of 36
-- rows across 4 orgs carried a property.
--
-- 📌 The shape is decision 24's, one table over: a consumer written when there
-- was one case, still correct for that case, silently wrong for the second. One
-- org with one building needs no segregation. The rule was written for the
-- portfolio, and the portfolio arrived.
--
-- What this migration does NOT do: refuse a payable that names no property.
-- Measured live, 45 of 45 POC payments and 22 of 22 POC requisitions carry no
-- ticket, and therefore no property. Refusing those outright would stop real
-- money on the strength of a data gap the payer did not create. They keep
-- drawing on the org-level row, which stays — but it is now *stated* as the
-- unattributed fund rather than being the only fund there is, and the refusal
-- message says so.

-- ── 1. Which purposes are scoped to a property ───────────────────────────────
--
-- One resolver, extended (decision 8), not a second scoping mechanism. Adding
-- `landlord_payable` here later is a one-line change and every consumer below
-- follows automatically.
create or replace function property_scoped_ledger_purposes()
returns ledger_account_purpose[]
language sql immutable set search_path = public as $fn$
  select array['service_charge_fund']::ledger_account_purpose[];
$fn$;

comment on function property_scoped_ledger_purposes() is
  'The ledger purposes held per property rather than per organisation (0247).';

-- A property-level row per (org, purpose, property, currency), and no more.
create unique index if not exists ledger_accounts_org_purpose_property_uidx
  on ledger_accounts (org_id, purpose, property_id, currency)
  where property_id is not null;

create index if not exists ledger_accounts_property_idx
  on ledger_accounts (property_id) where property_id is not null;

-- ── 2. Creating a property's account on demand ───────────────────────────────
--
-- On demand, because a property is filed long after `ensure_default_ledger_accounts`
-- ran for the org, and a chart of accounts that had to be re-seeded every time
-- someone adds a building is a chart of accounts that will be wrong.
--
-- `code` is unique per org (`ledger_accounts_org_code_uidx`), so a property row
-- cannot also be called "2000". It becomes a sub-account — 2000.001, 2000.002 —
-- which is what an accountant expects to see under a control account, and which
-- deliberately does NOT match `canonical_ledger_account`'s
-- `^[0-9]+(-[A-Z]{3})?$` preference, so a three-argument (org-level) lookup
-- still resolves the plain 2000 exactly as it does today.
create or replace function ensure_property_ledger_account(
  p_org_id uuid,
  p_purpose ledger_account_purpose,
  p_property_id uuid,
  p_currency text default 'NGN'
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_currency text := upper(trim(coalesce(p_currency, 'NGN')));
  v_existing uuid;
  v_base ledger_accounts%rowtype;
  v_prop record;
  v_seq int;
  v_code text;
  v_id uuid;
begin
  if p_property_id is null then
    raise exception 'ensure_property_ledger_account needs a property';
  end if;
  if not (p_purpose = any (property_scoped_ledger_purposes())) then
    raise exception 'purpose % is not held per property', p_purpose;
  end if;

  select id into v_existing
    from ledger_accounts
   where org_id = p_org_id and purpose = p_purpose
     and property_id = p_property_id and currency = v_currency;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_prop from properties where id = p_property_id;
  if v_prop.id is null or v_prop.org_id is distinct from p_org_id then
    raise exception 'that property does not belong to this organisation';
  end if;

  -- The org-level row is the control account this one hangs under; it also
  -- supplies the class and the human name.
  select * into v_base
    from ledger_accounts
   where org_id = p_org_id and purpose = p_purpose
     and property_id is null and currency = v_currency
   order by (code ~ '^[0-9]+(-[A-Z]{3})?$') desc, code, created_at, id
   limit 1;
  if v_base.id is null then
    raise exception
      'the chart of accounts has no % account for this organisation — set it up before collecting or committing against a property',
      replace(p_purpose::text, '_', ' ');
  end if;

  select coalesce(max(substring(code from '^' || split_part(v_base.code, '-', 1) || '\.(\d+)')::int), 0) + 1
    into v_seq
    from ledger_accounts
   where org_id = p_org_id
     and code ~ ('^' || split_part(v_base.code, '-', 1) || '\.\d+');

  v_code := split_part(v_base.code, '-', 1) || '.' || lpad(v_seq::text, 3, '0')
            || case when v_currency = 'NGN' then '' else '-' || v_currency end;

  insert into ledger_accounts (org_id, code, name, class, purpose, property_id, currency)
  values (
    p_org_id, v_code,
    split_part(v_base.name, ' — ', 1) || ' — ' || v_prop.name,
    v_base.class, p_purpose, p_property_id, v_currency
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a race, or the generated code collided. Re-read rather than retry:
    -- the unique index above means the winner is the row we wanted.
    select id into v_id
      from ledger_accounts
     where org_id = p_org_id and purpose = p_purpose
       and property_id = p_property_id and currency = v_currency;
  end if;

  if v_id is null then
    raise exception
      'could not open a service-charge fund account for %', v_prop.name;
  end if;

  return v_id;
end;
$fn$;

comment on function ensure_property_ledger_account(uuid, ledger_account_purpose, uuid, text) is
  'Opens (or returns) the sub-account holding one property''s funds (0247).';

-- ── 3. Resolving an account, now with a place ────────────────────────────────
--
-- A fourth argument rather than a default on the existing three, deliberately:
-- a default would make every current call site silently keep the pooled row
-- while reading as though it were property-aware. The three-argument form
-- remains, unchanged, and now means one specific thing — the organisation-level
-- (unattributed) account.
create or replace function canonical_ledger_account(
  p_org_id uuid,
  p_purpose ledger_account_purpose,
  p_currency text,
  p_property_id uuid
)
returns uuid
language plpgsql volatile security definer set search_path = public as $fn$
begin
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    raise exception 'not permitted to resolve accounts for another organisation';
  end if;

  if p_property_id is null or not (p_purpose = any (property_scoped_ledger_purposes())) then
    return canonical_ledger_account(p_org_id, p_purpose, p_currency);
  end if;

  return ensure_property_ledger_account(p_org_id, p_purpose, p_property_id, p_currency);
end;
$fn$;

comment on function canonical_ledger_account(uuid, ledger_account_purpose, text, uuid) is
  'Resolves the ledger account for a purpose at a property; falls back to the organisation-level account when the purpose is not property-scoped or no property is known (0247).';

-- ── 4. Which property a payable is drawn against ─────────────────────────────
--
-- Neither `payments` nor `ops_requisitions` carries a property; both carry a
-- nullable `ticket_id`, and the ticket carries the property. That is the only
-- link there has ever been, so it is the link this reads — and it returns NULL
-- honestly rather than guessing when there is no ticket.
create or replace function payable_property_id(p_payable_type text, p_payable_id uuid)
returns uuid
language sql stable security definer set search_path = public as $fn$
  select case p_payable_type
    when 'vendor_payment' then (
      select t.property_id from payments p
        join tickets t on t.id = p.ticket_id
       where p.id = p_payable_id
    )
    when 'ops_requisition' then (
      select t.property_id from ops_requisitions r
        join tickets t on t.id = r.ticket_id
       where r.id = p_payable_id
    )
    else null
  end;
$fn$;

comment on function payable_property_id(text, uuid) is
  'The property a payable is drawn against, via its ticket; NULL when it names none (0247).';

-- ── 5. The three writers now name the property they are spending ─────────────
--
-- Rebuilt from the live catalogue (`pg_get_functiondef`), not retyped from the
-- migration that last wrote them — 0183's rule, and these are money paths where
-- a clause lost to a typo is a money bug.

create or replace function recognise_vendor_payable(p_payment_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  pay payments%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into pay from payments where id = p_payment_id for update;
  if pay.id is null then
    raise exception 'payment not found';
  end if;

  if pay.payable_entry_id is not null then
    return pay.payable_entry_id;
  end if;

  if pay.approved_at is null or pay.status not in ('approved', 'remitted') then
    raise exception 'an unapproved payment is not yet a liability';
  end if;

  v_fund := canonical_ledger_account(
    pay.org_id, 'service_charge_fund', 'NGN',
    payable_property_id('vendor_payment', pay.id)
  );
  v_payable := canonical_ledger_account(pay.org_id, 'vendor_payable');

  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    pay.org_id, coalesce(pay.approved_at::date, current_date),
    'Vendor invoice approved', pay.invoice_reference, 'adjustment',
    'payment', pay.id, pay.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (pay.org_id, v_entry, v_fund, pay.amount, 'Committed from the service charge fund'),
         (pay.org_id, v_entry, v_payable, -pay.amount, 'Owed to the vendor');

  update payments set payable_entry_id = v_entry where id = pay.id;
  return v_entry;
end;
$fn$;

create or replace function recognise_requisition_payable(p_requisition_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  req ops_requisitions%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into req from ops_requisitions where id = p_requisition_id for update;
  if req.id is null then
    raise exception 'requisition not found';
  end if;

  -- The caller, not merely the requisition. A signed-in caller must belong to
  -- the requisition's own organisation; a service-role caller has no
  -- auth.uid() and is trusted, exactly as create_rent_remittance is.
  if auth.uid() is not null and req.org_id is distinct from current_user_org_id() then
    raise exception 'that requisition belongs to another organisation';
  end if;

  if req.payable_entry_id is not null then
    return req.payable_entry_id;
  end if;

  if req.approved_at is null or req.status <> 'approved' then
    raise exception 'an unapproved requisition is not yet a liability';
  end if;

  v_fund := canonical_ledger_account(
    req.org_id, 'service_charge_fund', 'NGN',
    payable_property_id('ops_requisition', req.id)
  );
  v_payable := canonical_ledger_account(req.org_id, 'requisition_payable');
  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    req.org_id, coalesce(req.approved_at::date, current_date),
    'Requisition approved', req.reference, 'adjustment',
    'ops_requisition', req.id, req.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (req.org_id, v_entry, v_fund,     req.total_amount, 'Committed from the service charge fund'),
         (req.org_id, v_entry, v_payable, -req.total_amount, 'Owed against the requisition');

  update ops_requisitions set payable_entry_id = v_entry where id = req.id;
  return v_entry;
end;
$fn$;

-- A service-charge collection credits the fund of the property it was billed
-- for. `record_collection` is otherwise byte-identical to the live definition —
-- only the two lines resolving `v_credit` change.
create or replace function record_collection(
  p_intent_id uuid,
  p_amount_verified numeric,
  p_paid_at timestamptz default now()
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
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
  v_property uuid;
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

  -- The building this money was billed for. A service charge is raised against
  -- a budget, and a budget names its property — so the fund it credits is that
  -- property's, not the organisation's.
  if intent.service_charge_id is not null then
    select sb.property_id into v_property
      from service_charges sc join sc_budgets sb on sb.id = sc.budget_id
     where sc.id = intent.service_charge_id;
  end if;

  v_bank := collection_bank_account(intent.org_id, intent.currency);
  v_credit := canonical_ledger_account(intent.org_id, v_purpose, intent.currency, v_property);

  if v_bank is null or v_credit is null then
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

    if intent.service_charge_id is not null then
      update service_charges
         set amount_paid = amount_paid + p_amount_verified,
             status = case
               when amount_paid + p_amount_verified >= amount then 'paid'
               else 'part_paid'
             end
       where id = intent.service_charge_id;
    end if;
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
$fn$;

-- ── 6. The refusal, in language a person can act on ──────────────────────────
--
-- Three different failures were collapsed into one sentence about
-- counterparties. They are told apart here by what the account actually is,
-- and each says what to DO about it.
create or replace function assert_funds_available()
returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_account uuid := coalesce(new.account_id, old.account_id);
  acct ledger_accounts%rowtype;
  v_balance numeric(16,2);
  v_place text;
  v_money text;
begin
  select * into acct from ledger_accounts where id = v_account;
  if acct.id is null then return null; end if;

  select coalesce(sum(amount), 0) into v_balance
  from ledger_postings where account_id = v_account;

  -- Client funds are an asset: debit-normal, so the balance is what is held.
  -- Negative means money has been disbursed that was never received.
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

-- ── 7. Asking BEFORE clicking send ───────────────────────────────────────────
--
-- The refusal above still arrives at COMMIT, deep inside a trigger, which is
-- the right place for a guarantee and the wrong place for a first warning. This
-- is the same question asked in advance, so the queue can show it and the
-- officer is never surprised by it.
create or replace function payable_funding_state(p_payable_type text, p_payable_id uuid)
returns table (
  property_id uuid,
  property_name text,
  fund_code text,
  required numeric,
  available numeric,
  shortfall numeric,
  sufficient boolean,
  already_recognised boolean
)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_prop uuid;
  v_required numeric(16,2);
  v_recognised boolean;
  v_acct uuid;
  v_available numeric(16,2);
begin
  if p_payable_type = 'vendor_payment' then
    select p.org_id, p.amount, p.payable_entry_id is not null
      into v_org, v_required, v_recognised
      from payments p where p.id = p_payable_id;
  elsif p_payable_type = 'ops_requisition' then
    select r.org_id, r.total_amount, r.payable_entry_id is not null
      into v_org, v_required, v_recognised
      from ops_requisitions r where r.id = p_payable_id;
  else
    return;
  end if;

  if v_org is null then return; end if;
  if auth.uid() is not null and v_org is distinct from current_user_org_id() then
    raise exception 'that payable belongs to another organisation';
  end if;

  v_prop := payable_property_id(p_payable_type, p_payable_id);

  -- Every column qualified: this function's OUT parameters include
  -- `property_id`, which is also a column here, and an unqualified reference
  -- resolves to the parameter.
  select la.id into v_acct
    from ledger_accounts la
   where la.org_id = v_org
     and la.purpose = 'service_charge_fund'
     and la.currency = 'NGN'
     and la.property_id is not distinct from v_prop;

  -- A fund that has not been opened yet holds nothing; that is a true answer,
  -- not a missing one.
  select coalesce(-sum(lp.amount), 0) into v_available
    from ledger_postings lp where lp.account_id = v_acct;
  v_available := coalesce(v_available, 0);

  return query
  select
    v_prop,
    (select p.name from properties p where p.id = v_prop),
    (select la.code from ledger_accounts la where la.id = v_acct),
    v_required,
    v_available,
    greatest(v_required - v_available, 0),
    -- Already recognised means the commitment is posted; sending it again does
    -- not draw on the fund a second time, so the fund cannot block it.
    (v_recognised or v_available >= v_required),
    v_recognised;
end;
$fn$;

comment on function payable_funding_state(text, uuid) is
  'What a payable needs and what its property''s fund holds, asked before the send rather than at commit (0247).';

-- ── 8. The pooled balances, reallocated rather than rewritten ────────────────
--
-- History is not edited. Every posting made before today stays exactly where it
-- was made; the balance is moved by a dated journal entry, which is what an
-- accountant does when a control account is broken out into sub-accounts, and
-- which leaves both sides visible in the journal afterwards.
--
-- Only what can be ATTRIBUTED moves: a service-charge collection knows its
-- invoice, the invoice knows its budget, and the budget names its property.
-- Anything else — a manual adjustment, a collection with no service charge —
-- stays on the org-level row and is now named as unattributed.
do $$
declare
  r record;
  v_entry uuid;
  v_prop_acct uuid;
begin
  for r in
    select la.id      as org_acct,
           la.org_id  as org_id,
           la.currency as currency,
           sb.property_id as property_id,
           sum(lp.amount) as amt
      from ledger_postings lp
      join ledger_accounts la on la.id = lp.account_id
      join ledger_entries  le on le.id = lp.entry_id
      join payment_intents pi on pi.id = le.entity_id and le.entity_type = 'payment_intent'
      join service_charges sc on sc.id = pi.service_charge_id
      join sc_budgets      sb on sb.id = sc.budget_id
     where la.purpose = 'service_charge_fund'
       and la.property_id is null
       and sb.property_id is not null
     group by la.id, la.org_id, la.currency, sb.property_id
    having sum(lp.amount) <> 0
  loop
    v_prop_acct := ensure_property_ledger_account(
      r.org_id, 'service_charge_fund', r.property_id, r.currency
    );

    insert into ledger_entries (org_id, entry_date, description, source,
                                entity_type, entity_id)
    values (
      r.org_id, current_date,
      'Reallocation — pooled service-charge funds to the property they were collected for',
      'adjustment', 'property', r.property_id
    )
    returning id into v_entry;

    insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
    values (r.org_id, v_entry, r.org_acct,   -r.amt, 'Out of the pooled fund'),
           (r.org_id, v_entry, v_prop_acct,   r.amt, 'Into this property''s own fund');
  end loop;
end $$;

-- The org-level row now means something narrower than it did this morning, and
-- says so on the chart of accounts.
update ledger_accounts
   set name = 'Service charge funds held — unattributed'
 where purpose = 'service_charge_fund'
   and property_id is null
   and name = 'Service charge funds held';

-- ── 9. Who may call these ────────────────────────────────────────────────────
--
-- 0204/0209/0210, for the fourth time: `create or replace` re-applies Supabase's
-- default grants, so a function that was correctly closed can be silently
-- reopened by being replaced. Every function this migration writes or rewrites
-- is closed here, and the assertion below fails the migration rather than
-- shipping a wrong grant.
revoke all on function property_scoped_ledger_purposes() from public, anon;
revoke all on function ensure_property_ledger_account(uuid, ledger_account_purpose, uuid, text) from public, anon;
revoke all on function canonical_ledger_account(uuid, ledger_account_purpose, text, uuid) from public, anon;
revoke all on function canonical_ledger_account(uuid, ledger_account_purpose, text) from public, anon;
revoke all on function payable_property_id(text, uuid) from public, anon;
revoke all on function payable_funding_state(text, uuid) from public, anon;
revoke all on function recognise_vendor_payable(uuid) from public, anon;
revoke all on function recognise_requisition_payable(uuid) from public, anon;
revoke all on function record_collection(uuid, numeric, timestamptz) from public, anon;
-- A trigger function, replaced above and therefore re-granted to PUBLIC by
-- Supabase's default. See 0250b's note for why closing it is free.
revoke all on function assert_funds_available() from public, anon;
grant execute on function assert_funds_available() to authenticated, service_role;

grant execute on function property_scoped_ledger_purposes() to authenticated, service_role;
grant execute on function payable_property_id(text, uuid) to authenticated, service_role;
grant execute on function payable_funding_state(text, uuid) to authenticated, service_role;
grant execute on function canonical_ledger_account(uuid, ledger_account_purpose, text, uuid) to service_role;
grant execute on function ensure_property_ledger_account(uuid, ledger_account_purpose, uuid, text) to service_role;
grant execute on function recognise_vendor_payable(uuid) to service_role;
grant execute on function recognise_requisition_payable(uuid) to service_role;
grant execute on function record_collection(uuid, numeric, timestamptz) to service_role;

do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in (
       'property_scoped_ledger_purposes', 'ensure_property_ledger_account',
       'canonical_ledger_account', 'payable_property_id', 'payable_funding_state',
       'recognise_vendor_payable', 'recognise_requisition_payable', 'record_collection',
       'assert_funds_available'
     );
  if v_bad is not null then
    raise exception
      'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
