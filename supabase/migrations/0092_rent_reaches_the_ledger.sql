-- Rent collected splits into the landlord's money and ours, in the ledger.
--
-- ⚠️ **The fee never reached the ledger.** `record_collection` credits the whole
-- receipt to `landlord_payable` for any rent intent, so a ₦12,000,000 rent
-- payment made the landlord a creditor for ₦12,000,000 — including the
-- ₦1,200,000 management fee the org had already earned. The rent roll showed the
-- correct net; the ledger, which is what the landlord is actually paid from,
-- did not.
--
-- ⚠️ **And there were THREE sources for one number.** `payment_settings.management_fee_percent`
-- (0027, used by `create_landlord_remittance`), `orgs.management_fee_pct` +
-- `landlord_terms` (0090, decision 14), and the snapshot frozen onto each
-- `rent_charges` row. CLAUDE.md is explicit that two mechanisms answering the
-- same question is how the ledger-account resolver ended up applied in half the
-- places that needed it — this is three, and they could disagree about what a
-- landlord is owed.
--
-- Resolved by making the SNAPSHOT authoritative for rent. The fee is taken once,
-- at collection, from the figures frozen when the demand was raised; remittance
-- then pays out a balance that is already net and recomputes nothing.

-- ── Which demand a payment settles ────────────────────────────────────────
alter table payment_intents add column if not exists rent_charge_id uuid;

alter table payment_intents drop constraint if exists payment_intents_rent_charge_fk;
alter table payment_intents add constraint payment_intents_rent_charge_fk
  foreign key (rent_charge_id) references rent_charges (id) on delete set null;

create index if not exists payment_intents_rent_charge_idx
  on payment_intents (rent_charge_id) where rent_charge_id is not null;

comment on column payment_intents.rent_charge_id is
  'The rent demand this payment settles. Its snapshotted fee split is what the ledger posting uses — never a rate read live at payment time.';

-- Which rent money has already been paid out, so a second remittance cannot
-- pay the same month twice.
alter table rent_charges add column if not exists remitted_at timestamptz;
alter table rent_charges add column if not exists remittance_id uuid;

-- ── The posting ───────────────────────────────────────────────────────────
--
-- Extends `record_collection` rather than adding a parallel path. A rent intent
-- carrying a charge splits its credit; everything else behaves exactly as before,
-- which is why the collections suite still passes unchanged.
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

  -- Already posted: hand back the existing entry. A retry is normal traffic.
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
    -- The fee, taken once, from the rate frozen when the demand was raised.
    -- Apportioned to what was actually received, so a part payment does not
    -- hand the org its whole fee out of the landlord's first instalment.
    v_fee_total := round(
      (rc.management_fee_amount + rc.admin_fee_amount) * (p_amount_verified / rc.amount), 2
    );
    if v_fee_total < 0 then v_fee_total := 0; end if;
    if v_fee_total > p_amount_verified then v_fee_total := p_amount_verified; end if;

    -- The landlord takes the remainder rather than a second rounding, so the
    -- postings always sum to the receipt and the balance trigger is satisfied.
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

    -- The demand follows the money.
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
                   else 'partially_paid'::payment_intent_status end;

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

comment on function record_collection is
  'Posts a collection. A rent receipt carrying a rent_charge splits into the landlord''s share and the fee using the rate SNAPSHOTTED on the demand — the fee is taken here, once, and remittance never recomputes it.';

-- ── Raising the demand a tenant actually pays ─────────────────────────────
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

  -- One live intent per demand, mirroring 0045's rule for invoices: two open
  -- checkout links for one debt is how a tenant pays twice.
  if exists (
    select 1 from payment_intents
     where rent_charge_id = rc.id and status in ('pending', 'processing')
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

comment on function create_rent_payment_intent is
  'Opens a payment for the outstanding balance of a rent demand. One live intent per demand — two open checkout links for one debt is how a tenant pays twice.';
