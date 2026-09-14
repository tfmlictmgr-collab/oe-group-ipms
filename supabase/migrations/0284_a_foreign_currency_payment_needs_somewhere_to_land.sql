-- A foreign-currency payment needs somewhere to land (9 Sept 2026).
--
-- `0281`/`0282` carried a `currency` column through the whole off-platform path
-- — the claim, the allocation, the synthetic intent — and `record_collection`
-- has been multi-currency since `0103`. So an FX bank transfer LOOKED supported.
-- Measured, it was supported for exactly one kind of line.
--
-- ⚠️ `ensure_currency_ledger_accounts` (0103) provisions **two** accounts for a
-- new currency: `client_funds` and `suspense`. That was right for what it was
-- written for — a Flutterwave FX collection whose money lands in the bank and
-- sits in suspense until somebody attributes it. It is not enough for anything
-- that ATTRIBUTES the money at the moment it arrives, which is precisely what
-- this feature does:
--
--     rent line    -> needs `landlord_payable` AND `fee_income` in that currency
--     deposit line -> needs `tenant_deposit`
--     other line   -> needs `suspense`               (the only one that existed)
--
-- So a USD rent payment would have been recorded, climbed all three desks, and
-- then failed at the Payment Officer's confirmation with "the chart of accounts
-- has no fee income account for this organisation" — after three people had
-- signed it, which is the worst possible moment to discover a configuration gap.
--
-- 📌 The shape decision 24 keeps finding, one table further out: `0103` wrote a
-- provisioner for the case in front of it, and it stayed correct for that case
-- while silently becoming insufficient for the next one. The fix is in two
-- halves — provision the accounts an inbound attribution actually needs, AND
-- refuse at SUBMISSION rather than at posting, which is `raisePaymentRequest`'s
-- own rule for the gateway path.

-- ── 1. The chart a currency actually needs ──────────────────────────────────
--
-- Rebuilt from `pg_get_functiondef` with the account list extended. The guard,
-- the currency-format check and the NGN early return are catalogue output.
--
-- Codes mirror the NGN chart exactly (1000/2100/2300/4000/9000), suffixed with
-- the currency — the convention `0103` established and `canonical_ledger_account`
-- already parses.
--
-- ⚠️ `service_charge_fund` is deliberately NOT here. Service charges are a
-- domestic Naira obligation by design — `create_service_charge_payment_intent`
-- (0123) hardcodes 'NGN' and decision 15 treats the whole service-charge cycle
-- as Naira — so an FX service-charge fund would be an account for a thing that
-- cannot happen. Section 3 refuses the allocation instead, which says so.
create or replace function ensure_currency_ledger_accounts(p_org_id uuid, p_currency text)
returns void language plpgsql security definer set search_path = public as $fn$
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
     'liability', 'suspense', v_currency),
    -- 0284. The three an inbound attribution needs.
    (p_org_id, '2100-' || v_currency, 'Landlord rent payable — ' || v_currency,
     'liability', 'landlord_payable', v_currency),
    (p_org_id, '2300-' || v_currency, 'Tenant deposits held — ' || v_currency,
     'liability', 'tenant_deposit', v_currency),
    (p_org_id, '4000-' || v_currency, 'Management & admin fees — ' || v_currency,
     'income', 'fee_income', v_currency)
  on conflict do nothing;
end;
$fn$;

comment on function ensure_currency_ledger_accounts is
  'Provisions the minimal chart for a currency: the bank account, suspense, and the three an inbound collection attributes to (landlord payable, tenant deposits, fee income). Service charge is Naira-only by design (0284).';

-- ── 2. Every currency an org has already enabled gets the missing rows ──────
--
-- A migration that fixes the provisioner and leaves the already-provisioned
-- orgs broken is a fix for nobody who has the problem. `0221`'s rule: a fix that
-- only applies going forward is not a fix for the person who reported it.
--
-- Driven off the CURRENCIES THAT EXIST rather than a hardcoded list, so an org
-- that enabled ZAR gets ZAR's rows and nobody has to remember to add it here.
do $$
declare r record;
begin
  for r in
    select distinct la.org_id, la.currency
      from ledger_accounts la
     where la.currency <> 'NGN'
  loop
    insert into ledger_accounts (org_id, code, name, class, purpose, currency)
    values
      (r.org_id, '2100-' || r.currency, 'Landlord rent payable — ' || r.currency,
       'liability', 'landlord_payable', r.currency),
      (r.org_id, '2300-' || r.currency, 'Tenant deposits held — ' || r.currency,
       'liability', 'tenant_deposit', r.currency),
      (r.org_id, '4000-' || r.currency, 'Management & admin fees — ' || r.currency,
       'income', 'fee_income', r.currency)
    on conflict do nothing;
  end loop;
end $$;

-- ── 3. The breakdown is vetted against the chart, at submission ─────────────
--
-- Rebuilt from the live catalogue with two additions, both inside the loop that
-- already resolves each line's purpose:
--
--   • a service-charge line is refused outright in a currency other than NGN;
--   • every line's purpose must have an account in the claim's currency BEFORE
--     the claim is accepted.
--
-- ⚠️ The second one is the important half and it is a rule about WHEN. The
-- posting would have refused too — `record_collection` raises "the chart of
-- accounts has no fee income account" — but it would have refused at the
-- terminal desk, after the audit and executive desks had already signed. A
-- configuration gap discovered there costs three people's time and tells the
-- payer nothing useful. `raisePaymentRequest` learned this for the gateway path
-- ("refused HERE, before a checkout link is ever raised"); the reasoning
-- transfers exactly, and the gap is wider here because the chain is longer.
create or replace function write_offline_claim_allocations(
  p_claim_id uuid,
  p_allocations jsonb,
  p_amount numeric
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_actor uuid := active_uid();
  c offline_payment_claims%rowtype;
  v_line jsonb;
  v_sum numeric(16,2) := 0;
  v_amount numeric(16,2);
  v_purpose collection_purpose;
  v_ledger_purpose ledger_account_purpose;
  v_rc rent_charges%rowtype;
  v_sc service_charges%rowtype;
  v_lease leases%rowtype;
  v_property uuid;
  v_unit uuid;
  v_outstanding numeric(16,2);
  v_own boolean;
  v_payer uuid;
  v_own_properties uuid[] := array[]::uuid[];
  v_staff boolean;
begin
  select * into c from offline_payment_claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'that recorded payment could not be found';
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'say what this payment is for - pick at least one demand or invoice';
  end if;

  v_staff := has_permission('payments.record_offline');
  v_payer := c.payer_user_id;

  delete from offline_payment_allocations where claim_id = c.id;

  -- ── PASS ONE: lines that name a charge ───────────────────────────────────
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := null;
    v_unit := null;
    v_own := false;

    if v_amount is null or v_amount <= 0 then
      raise exception 'every line of the breakdown needs an amount';
    end if;
    v_sum := v_sum + v_amount;

    -- 0284. Which ledger account this line will credit when it posts. The same
    -- mapping `record_collection` makes, asked here so a gap is a refusal now
    -- rather than an exception three signatures later.
    v_ledger_purpose := case v_purpose
      when 'rent' then 'landlord_payable'
      when 'service_charge' then 'service_charge_fund'
      when 'deposit' then 'tenant_deposit'
      else 'suspense'
    end;

    if v_purpose = 'rent' then
      select * into v_rc from rent_charges where id = (v_line->>'rent_charge_id')::uuid;
      if v_rc.id is null or v_rc.org_id is distinct from c.org_id then
        raise exception 'one of the rent demands on this payment could not be found';
      end if;
      select * into v_lease from leases where id = v_rc.lease_id;
      v_property := v_lease.property_id;
      v_unit := v_lease.unit_id;
      v_own := v_lease.tenant_user_id = v_actor;
      v_outstanding := v_rc.amount - v_rc.amount_paid;
      v_payer := coalesce(v_payer, v_lease.tenant_user_id);

      if upper(v_rc.currency) <> upper(c.currency) then
        raise exception 'that rent demand is in % and this payment is in %',
          v_rc.currency, c.currency;
      end if;

    elsif v_purpose = 'service_charge' then
      -- 0284. Naira only, and said plainly. `create_service_charge_payment_intent`
      -- (0123) has hardcoded NGN since it was written and decision 15 treats the
      -- whole service-charge cycle as a domestic obligation; an FX service charge
      -- is not a thing this platform bills, so it is not a thing it can be paid.
      if upper(c.currency) <> 'NGN' then
        raise exception
          'service charges are billed in naira, so a % payment cannot be put against one - record the naira part separately',
          c.currency;
      end if;

      select * into v_sc from service_charges
       where id = (v_line->>'service_charge_id')::uuid and deleted_at is null;
      if v_sc.id is null or v_sc.org_id is distinct from c.org_id then
        raise exception 'one of the service-charge invoices on this payment could not be found';
      end if;
      select sb.property_id into v_property from sc_budgets sb where sb.id = v_sc.budget_id;
      v_unit := v_sc.unit_id;
      v_own := v_sc.billed_to_user_id = v_actor;
      v_outstanding := v_sc.amount - v_sc.amount_paid;
      v_payer := coalesce(v_payer, v_sc.billed_to_user_id);

    else
      -- deposit / other. Pass two, once we know which properties the caller has
      -- standing on through their own charges.
      continue;
    end if;

    -- 0284. Can this line actually be posted in this currency?
    if canonical_ledger_account(c.org_id, v_ledger_purpose, c.currency,
                                case when v_purpose = 'service_charge' then v_property end) is null then
      raise exception
        'this organisation has no % account in % - an administrator enables the currency under Settings before a payment in it can be recorded',
        replace(v_ledger_purpose::text, '_', ' '), c.currency;
    end if;
    if v_purpose = 'rent'
       and canonical_ledger_account(c.org_id, 'fee_income', c.currency) is null then
      raise exception
        'this organisation has no fee income account in % - an administrator enables the currency under Settings before rent in it can be recorded',
        c.currency;
    end if;

    -- Standing. Your own charge, or somebody else's while holding the capability
    -- AND reaching the place - decision 26's rule that a capability grants the
    -- act and never the reach.
    if not coalesce(v_own, false) then
      if not v_staff then
        raise exception 'that demand is billed to somebody else';
      end if;
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage the property that demand belongs to';
      end if;
    else
      v_own_properties := v_own_properties || v_property;
    end if;

    -- Checked, and NOT silently trimmed. If somebody transferred more than a
    -- demand is worth, the excess is real money that has to be accounted for
    -- somewhere; quietly reducing the line would lose it. The remedy the form
    -- offers is a "credit on account" line, which is pass two.
    if v_amount > v_outstanding then
      raise exception
        'you have put % against a demand with only % outstanding - reduce it, or put the difference on account',
        trim(to_char(v_amount, 'FM999,999,999,990.00')),
        trim(to_char(v_outstanding, 'FM999,999,999,990.00'));
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, rent_charge_id, service_charge_id,
      property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose,
      case when v_purpose = 'rent' then v_rc.id end,
      case when v_purpose = 'service_charge' then v_sc.id end,
      v_property, v_unit, v_amount
    );
  end loop;

  -- ── PASS TWO: deposits and money on account ──────────────────────────────
  --
  -- These name no charge, so there is no billed-to column to establish standing
  -- from. Staff may record them against any property they reach. A tenant may
  -- only put money on account at a property they are ALREADY paying something at
  -- on this same claim - which is exactly the overpayment case, and stops the
  -- field being a way to attach a credit to a building you have nothing to do
  -- with.
  for v_line in select * from jsonb_array_elements(p_allocations) loop
    v_purpose := (v_line->>'purpose')::collection_purpose;
    if v_purpose in ('rent', 'service_charge') then
      continue;
    end if;
    v_amount := round((v_line->>'amount')::numeric, 2);
    v_property := nullif(v_line->>'property_id', '')::uuid;
    v_ledger_purpose := case v_purpose when 'deposit' then 'tenant_deposit' else 'suspense' end;

    if v_property is null then
      raise exception 'a deposit or a credit on account has to say which property it belongs to';
    end if;
    if not exists (select 1 from properties where id = v_property and org_id = c.org_id) then
      raise exception 'that property could not be found';
    end if;

    if canonical_ledger_account(c.org_id, v_ledger_purpose, c.currency) is null then
      raise exception
        'this organisation has no % account in % - an administrator enables the currency under Settings before a payment in it can be recorded',
        replace(v_ledger_purpose::text, '_', ' '), c.currency;
    end if;

    if v_staff then
      if not (current_user_role() = any (oversight_roles()))
         and not (v_property in (select current_user_property_ids())) then
        raise exception 'you do not manage that property';
      end if;
    elsif not (v_property = any (v_own_properties)) then
      raise exception
        'you can only leave money on account at a property you are also paying a demand for on this payment';
    end if;

    insert into offline_payment_allocations (
      org_id, claim_id, purpose, property_id, unit_id, amount
    ) values (
      c.org_id, c.id, v_purpose, v_property,
      nullif(v_line->>'unit_id', '')::uuid, v_amount
    );
  end loop;

  -- The deferred trigger checks this too, at COMMIT, and its message is the one
  -- that matters. Stated here as well so the caller is told before the rest of
  -- the transaction runs, with the figure they actually typed in front of them.
  if v_sum <> round(p_amount, 2) then
    raise exception
      'the breakdown comes to % but the payment is % - every part of it has to be allocated to something',
      trim(to_char(v_sum, 'FM999,999,999,990.00')),
      trim(to_char(round(p_amount, 2), 'FM999,999,999,990.00'));
  end if;

  return v_payer;
end;
$fn$;

revoke all on function write_offline_claim_allocations(uuid, jsonb, numeric)
  from public, anon, authenticated, service_role;

comment on function write_offline_claim_allocations is
  'Replaces an off-platform claim breakdown, vetting every line against the caller standing, the charge outstanding balance, and the chart of accounts in the claim currency. Shared by the submit path (0281) and the correction path (0282).';

-- ── 4. What the form offers, in the currency it is offered in ──────────────
--
-- `offline_allocatable_charges` reported every service charge as 'NGN' — which
-- is true, and the form filters the list by the selected account's currency, so
-- picking a USD account correctly hid them. Stated here as a comment rather than
-- changed, because the literal IS the rule now that section 3 enforces it.
comment on function offline_allocatable_charges is
  'Every outstanding rent demand and service-charge invoice the caller may record an off-platform payment against. Service charges report NGN because they are billed in naira only (0123/0284); the form filters on it and write_offline_claim_allocations refuses the rest.';

-- ── 5. Assertions ───────────────────────────────────────────────────────────
do $$
declare
  v_org uuid;
  v_missing text[];
begin
  -- Every non-NGN currency any org has enabled now carries the five accounts an
  -- inbound collection can need.
  select array_agg(distinct la.currency || '/' || p.purpose) into v_missing
    from (select distinct org_id, currency from ledger_accounts where currency <> 'NGN') la
    cross join (values ('client_funds'), ('suspense'), ('landlord_payable'),
                       ('tenant_deposit'), ('fee_income')) as p(purpose)
   where not exists (
     select 1 from ledger_accounts x
      where x.org_id = la.org_id and x.currency = la.currency
        and x.purpose = p.purpose::ledger_account_purpose
        and x.property_id is null
   );
  if v_missing is not null then
    raise exception 'a currency is still missing accounts: %', array_to_string(v_missing, ', ');
  end if;

  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'ensure_currency_ledger_accounts'))
     not like '%fee_income%' then
    raise exception 'the currency provisioner still cannot open a fee income account';
  end if;

  -- 0281's own rules must have survived the rebuild: the standing test, the
  -- outstanding-balance test and the reconciliation test are what make this
  -- function safe, and a rebuild that lost one would be 0271 again.
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'write_offline_claim_allocations'))
     not like '%current_user_property_ids%' then
    raise exception 'the allocation writer lost its place scoping in the rebuild';
  end if;
  if pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'write_offline_claim_allocations'))
     not like '%outstanding%' then
    raise exception 'the allocation writer lost its overpayment guard in the rebuild';
  end if;
  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name = 'write_offline_claim_allocations'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) > 0 then
    raise exception 'the rebuild re-granted the internal allocation writer';
  end if;
end $$;
