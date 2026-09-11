-- Two invented enum values, and a broken collection path.
--
-- ⚠️ `0092` rewrote `record_collection` and, while doing so, introduced
-- `'partially_paid'` — a value `payment_intent_status` does not have. The real
-- one is `'part_paid'`. It also gated the one-live-link check on
-- `status in ('pending', 'processing')`, and `'processing'` does not exist
-- either.
--
-- The consequence was total: **every collection failed**, rent and service
-- charge alike, because the status update at the end of the function runs on
-- every path. Not a rent-only regression — the whole money-in path was down.
--
-- 📌 I carried both names over from the remittance state machine, where
-- `processing` IS a status, and never checked them against the enum I was
-- actually writing to. Postgres cannot catch this at definition time: the cast
-- lives inside a function body and is only resolved when the line executes, so
-- the migration applied cleanly and the failure waited for the first payment.
-- **A function body is not type-checked until it runs; a suite is the only
-- thing standing between that and production.**
--
-- The real values, from `0032`:
--   payment_intent_status = pending | paid | part_paid | failed | abandoned | reversed

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

  v_bank := collection_bank_account(intent.org_id);
  v_credit := canonical_ledger_account(intent.org_id, v_purpose);

  if v_bank is null or v_credit is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  if intent.rent_charge_id is not null then
    select * into rc from rent_charges where id = intent.rent_charge_id for update;
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    intent.org_id, p_paid_at::date,
    'Collection — ' || replace(intent.purpose::text, '_', ' '),
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

    -- The landlord takes the remainder rather than a second rounding, so the
    -- postings always sum to the receipt.
    v_landlord_share := p_amount_verified - v_fee_total;

    v_fee := canonical_ledger_account(intent.org_id, 'fee_income');
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

-- And the one-live-link guard, gated on a status that exists.
create or replace function create_rent_payment_intent(
  p_rent_charge_id uuid,
  p_gateway payment_gateway default 'paystack'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rc rent_charges%rowtype;
  l  leases%rowtype;
  v_id uuid;
  v_ref text;
  v_outstanding numeric(16,2);
begin
  select * into rc from rent_charges where id = p_rent_charge_id;
  if rc.id is null then
    raise exception 'that rent demand could not be found';
  end if;
  if auth.uid() is not null and rc.org_id is distinct from current_user_org_id() then
    raise exception 'that demand belongs to another organisation';
  end if;

  v_outstanding := rc.amount - rc.amount_paid;
  if v_outstanding <= 0 then
    raise exception 'that rent has already been paid in full';
  end if;

  if exists (
    select 1 from payment_intents
     where rent_charge_id = rc.id and status = 'pending'
  ) then
    raise exception 'a payment link is already open for this rent demand';
  end if;

  select * into l from leases where id = rc.lease_id;
  v_ref := 'RENT-' || to_char(rc.period_start, 'YYYYMM') || '-' || left(replace(rc.id::text, '-', ''), 10);

  insert into payment_intents (
    org_id, purpose, rent_charge_id, property_id, unit_id, payer_user_id,
    amount_expected, currency, gateway, gateway_reference, created_by
  ) values (
    rc.org_id, 'rent', rc.id, l.property_id, l.unit_id, l.tenant_user_id,
    v_outstanding, rc.currency, p_gateway, v_ref, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function create_rent_payment_intent(uuid, payment_gateway) from public;
grant execute on function create_rent_payment_intent(uuid, payment_gateway) to authenticated, service_role;
